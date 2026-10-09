// Type-level dist smoke test (run by `pnpm smoke:dist` after `pnpm build`): the HatidError types
// declared by each built entry must stay mutually assignable, even though each .d.ts declares its own class.
import { HatidError as ServerHatidError, isHatidError as serverIsHatidError } from "../dist/server/index.js";
import { HatidError as ReactHatidError, isHatidError as reactIsHatidError } from "../dist/react/index.js";

declare const s: ServerHatidError;
declare const r: ReactHatidError;

export const a: ServerHatidError = r;
export const b: ReactHatidError = s;
export const c: ServerHatidError[] = [new ReactHatidError("STORAGE", "x")];
export const d: ReactHatidError[] = [new ServerHatidError("STORAGE", "x")];

export function narrow(e: unknown): [ServerHatidError | null, ReactHatidError | null] {
  return [reactIsHatidError(e) ? e : null, serverIsHatidError(e) ? e : null];
}
