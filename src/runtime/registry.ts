import type { EffectSpec } from "../spec/effectSpec.js";

export class MissingEffectSpecError extends Error {
  override name = "MissingEffectSpecError";
}

export class EffectRegistry {
  private readonly versions = new Map<string, Map<string, EffectSpec>>();
  private readonly current = new Map<string, string>();

  register(spec: EffectSpec, options: { current?: boolean } = {}): void {
    const byVersion = this.versions.get(spec.effect_name) ?? new Map<string, EffectSpec>();
    byVersion.set(spec.schema_version, spec);
    this.versions.set(spec.effect_name, byVersion);
    if (options.current !== false) this.current.set(spec.effect_name, spec.schema_version);
  }

  get(effect_name: string, version: string): EffectSpec {
    const spec = this.versions.get(effect_name)?.get(version);
    if (!spec) {
      throw new MissingEffectSpecError(
        `EffectSpec ${effect_name}@${version} is unavailable; refusing to reinterpret the action under another version`
      );
    }
    return spec;
  }

  latest(effect_name: string): EffectSpec {
    const version = this.current.get(effect_name);
    if (!version) throw new MissingEffectSpecError(`No current EffectSpec registered for ${effect_name}`);
    return this.get(effect_name, version);
  }
}
