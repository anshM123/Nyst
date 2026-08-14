-- Nyst v0.3.1 — issues 4 and 5. DURABLE INBOUND SUBMISSIONS.
--
-- THE DEFECT.
--
-- The contact form and the quote configurator both called an optional sink
-- that was never supplied:
--
--     if (options.record_contact) await options.record_contact(submission);
--     return html(reply, contactPage(submission.topic, true));
--
-- Every message a visitor sent was parsed, validated, discarded, and answered
-- with "Thank you -- we have it." Every quote was computed, displayed, and
-- forgotten. Nothing in the logs distinguished this from working correctly.
--
-- These two tables are where those submissions go. They are deliberately dull:
-- a lead is not an Effect, it has no receipt, and it has nothing to do with the
-- three-layer model. Storing it next to the Outcome layer would suggest
-- otherwise.

CREATE TABLE nyst_contact_submissions (
  contact_submission_id uuid PRIMARY KEY,
  -- Shown to the visitor so a lost message can be traced by both sides.
  -- Unambiguous alphabet: no O/0, no I/1.
  reference text NOT NULL UNIQUE CHECK (reference ~ '^NYST-LEAD-[0-9A-Z]{8}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  company text NOT NULL DEFAULT '' CHECK (length(company) <= 120),
  topic text NOT NULL DEFAULT 'general' CHECK (length(topic) <= 40),
  -- Stored EXACTLY as sent. Sanitising on the way in destroys the evidence of
  -- what was actually submitted; escaping happens on the way out.
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Operational context, for spam triage. Not identity.
  source_ip inet,
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled','spam')),
  handled_at timestamptz,
  handled_note text CHECK (handled_note IS NULL OR length(handled_note) <= 2000),
  CHECK ((status = 'new') = (handled_at IS NULL))
);

CREATE INDEX nyst_contact_submissions_new
  ON nyst_contact_submissions (received_at DESC) WHERE status = 'new';
CREATE INDEX nyst_contact_submissions_email
  ON nyst_contact_submissions (email, received_at DESC);

-- What a visitor asked for is history: the answer they were given must stay
-- exactly what they were given, or a later conversation starts from a
-- different quote than the one on their screen.
CREATE TABLE nyst_quote_requests (
  quote_request_id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE CHECK (reference ~ '^NYST-QUOTE-[0-9A-Z]{8}$'),
  -- The configurator inputs, verbatim.
  input jsonb NOT NULL,
  -- And what Nyst told them, at the time it told them.
  recommended_plan text NOT NULL CHECK (length(recommended_plan) BETWEEN 1 AND 60),
  received_at timestamptz NOT NULL DEFAULT now(),
  source_ip inet,
  -- Set only if they went on to identify themselves through the contact form.
  contact_submission_id uuid REFERENCES nyst_contact_submissions(contact_submission_id)
);

CREATE INDEX nyst_quote_requests_recent ON nyst_quote_requests (received_at DESC);

-- Append-only on the parts that are a record of what happened. Triage may move
-- the status forward; nobody may edit what a visitor wrote or what they were
-- quoted.
CREATE OR REPLACE FUNCTION nyst_contact_submissions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_contact_submissions is append-only: mark a submission as spam instead of deleting it';
  END IF;
  IF NEW.contact_submission_id <> OLD.contact_submission_id
     OR NEW.reference <> OLD.reference
     OR NEW.email <> OLD.email
     OR NEW.message <> OLD.message
     OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'a contact submission is immutable: only triage status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_contact_submissions_immutable
  BEFORE UPDATE OR DELETE ON nyst_contact_submissions
  FOR EACH ROW EXECUTE FUNCTION nyst_contact_submissions_immutable();

CREATE OR REPLACE FUNCTION nyst_quote_requests_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nyst_quote_requests is append-only';
  END IF;
  IF NEW.input <> OLD.input OR NEW.recommended_plan <> OLD.recommended_plan THEN
    RAISE EXCEPTION 'a quote is a record of what a visitor was told: it may not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nyst_quote_requests_immutable
  BEFORE UPDATE OR DELETE ON nyst_quote_requests
  FOR EACH ROW EXECUTE FUNCTION nyst_quote_requests_immutable();
