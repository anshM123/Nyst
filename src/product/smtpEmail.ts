/**
 * SMTP TRANSPORT.
 *
 * WHY NOT NODEMAILER.
 *
 * Nyst has four runtime dependencies, and that is a deliberate property rather
 * than an accident: every dependency in a system that authorizes consequential
 * actions is supply-chain surface. Nodemailer is an excellent library and it
 * would be the right call for an application that sends real volumes of varied
 * mail. Nyst sends two message shapes, both plain text, both to one recipient.
 *
 * What that actually needs is EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA —
 * which is this file. It is deliberately minimal, and it is honest about what
 * it does not implement: no connection pooling, no DKIM signing, no retry
 * queue, no 8BITMIME negotiation, no international addresses. If Nyst ever
 * needs those, swap in a real library behind `EmailProvider` and delete this.
 *
 * HEADER INJECTION IS THE ATTACK.
 *
 * A password-reset recipient is attacker-influenced (anyone can type an address
 * into the form). A CR or LF reaching a header lets the sender add `Bcc:` and
 * silently receive somebody else's reset link. Addresses are validated before
 * they get here, and every header value is re-checked at write time anyway —
 * two places, because one place is how this goes wrong.
 */
import { createConnection, type Socket } from "node:net";
import { connect as createTlsConnection, type TLSSocket } from "node:tls";
import { assertNoSensitiveContent, isDeliverableAddress, type EmailMessage, type EmailProvider, type SmtpSettings } from "./email.js";
import type { SecretProvider } from "./secretProvider.js";

const CRLF = "\r\n";

export class SmtpEmailProvider implements EmailProvider {
  constructor(
    private readonly settings: SmtpSettings,
    private readonly secrets: SecretProvider | null = null,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    assertNoSensitiveContent(message);
    if (!isDeliverableAddress(message.to)) throw new Error("Refusing to send to an undeliverable address");

    const password = this.settings.password_ref && this.secrets
      ? await this.secrets.resolve(this.settings.password_ref)
      : undefined;

    const session = await SmtpSession.open(this.settings, this.timeoutMs);
    try {
      await session.handshake();
      if (this.settings.user && password) await session.authenticate(this.settings.user, password);
      await session.deliver(this.settings.from, message);
      await session.quit();
    } finally {
      session.destroy();
    }
  }
}

/* ===================================================================== */

/** One SMTP conversation. Not reused, not pooled. */
class SmtpSession {
  #buffer = "";
  #waiting: ((line: string) => void) | null = null;
  #failure: Error | null = null;

  private constructor(private socket: Socket | TLSSocket, private readonly settings: SmtpSettings, private readonly timeoutMs: number) {
    this.attach(socket);
  }

  static async open(settings: SmtpSettings, timeoutMs: number): Promise<SmtpSession> {
    const socket = settings.secure
      ? createTlsConnection({ host: settings.host, port: settings.port, servername: settings.host })
      : createConnection({ host: settings.host, port: settings.port });
    socket.setTimeout(timeoutMs);
    await new Promise<void>((resolve, reject) => {
      socket.once(settings.secure ? "secureConnect" : "connect", () => resolve());
      socket.once("error", reject);
    });
    return new SmtpSession(socket, settings, timeoutMs);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      // A reply ends with "NNN " (space, not hyphen) on its final line.
      const complete = /(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(this.#buffer);
      if (complete && this.#waiting) {
        const reply = this.#buffer;
        this.#buffer = "";
        const notify = this.#waiting;
        this.#waiting = null;
        notify(reply);
      }
    });
    socket.on("timeout", () => { this.#failure = new Error("The SMTP server stopped responding"); socket.destroy(); });
    socket.on("error", (error: Error) => { this.#failure = error; });
  }

  /** Send a command and require one of `expected` as the reply code. */
  private async command(line: string | null, expected: readonly number[]): Promise<string> {
    if (this.#failure) throw this.#failure;
    const reply = new Promise<string>((resolve, reject) => {
      this.#waiting = resolve;
      setTimeout(() => reject(new Error("The SMTP server stopped responding")), this.timeoutMs).unref?.();
    });
    if (line !== null) this.socket.write(line + CRLF);
    const received = await reply;
    const code = Number(received.slice(0, 3));
    if (!expected.includes(code)) {
      // The reply text can echo back what we sent, so it is not repeated here.
      throw new Error(`The SMTP server refused ${line?.split(" ")[0] ?? "the greeting"} with code ${code}`);
    }
    return received;
  }

  async handshake(): Promise<void> {
    await this.command(null, [220]);
    const greeting = await this.command(`EHLO ${hostLabel(this.settings.from)}`, [250]);

    // STARTTLS on a plaintext connection, whenever the server offers it. A
    // password and a reset link must not cross the network in the clear, and
    // "the server didn't advertise it" is the only acceptable reason not to.
    if (!this.settings.secure && /\bSTARTTLS\b/i.test(greeting)) {
      await this.command("STARTTLS", [220]);
      const plain = this.socket;
      const upgraded = createTlsConnection({ socket: plain, servername: this.settings.host });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      this.#buffer = "";
      this.#waiting = null;
      this.socket = upgraded;
      upgraded.setTimeout(this.timeoutMs);
      this.attach(upgraded);
      // EHLO again: the server's capabilities may differ once encrypted.
      await this.command(`EHLO ${hostLabel(this.settings.from)}`, [250]);
    }
  }

  async authenticate(user: string, password: string): Promise<void> {
    // AUTH LOGIN: two base64 challenges. Neither value is ever logged, and a
    // failure message deliberately does not echo the credential back.
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(user, "utf8").toString("base64"), [334]);
    await this.command(Buffer.from(password, "utf8").toString("base64"), [235]);
  }

  async deliver(from: string, message: EmailMessage): Promise<void> {
    await this.command(`MAIL FROM:<${requireHeaderSafe(from)}>`, [250]);
    await this.command(`RCPT TO:<${requireHeaderSafe(message.to)}>`, [250, 251]);
    await this.command("DATA", [354]);

    const body = [
      `From: ${requireHeaderSafe(from)}`,
      `To: ${requireHeaderSafe(message.to)}`,
      `Subject: ${requireHeaderSafe(message.subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      // Dot-stuffing: a line that is exactly "." would end the DATA block early.
      message.text.replace(/\r?\n/g, CRLF).replace(/^\./gm, ".."),
      ".",
    ].join(CRLF);
    await this.command(body, [250]);
  }

  async quit(): Promise<void> {
    await this.command("QUIT", [221]).catch(() => undefined);
  }

  destroy(): void { this.socket.destroy(); }
}

/**
 * Refuse any header value carrying a line break or a NUL.
 *
 * The second of two checks. Addresses are validated on the way in, but this one
 * is at the exact moment of writing a header — which is the only place that can
 * actually be trusted, because it is the last thing before the wire.
 */
function requireHeaderSafe(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Refusing to write an email header containing a line break — this is header injection");
  }
  if (value.length > 998) throw new Error("Refusing to write an email header longer than the SMTP line limit");
  return value;
}

/** The EHLO identity. Derived from the sender domain, never from user input. */
function hostLabel(from: string): string {
  const domain = from.slice(from.indexOf("@") + 1);
  return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : "localhost";
}
