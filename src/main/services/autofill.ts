// DOM functions injected into a device's WebContentsView. They are serialized with
// Function.prototype.toString(), so they MUST be self-contained (no module-scope refs).

/** True if the page currently shows a visible password input (i.e. we're on a login screen). */
export function hasVisiblePasswordField(): boolean {
  const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
  return inputs.some((el) => {
    const style = getComputedStyle(el as Element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/**
 * Fill the login password field and optionally submit. Returns whether a password
 * input was found. Uses the native value setter so framework-controlled inputs
 * (React/Vue) register the change.
 */
export function fillLogin(password: string, submit: boolean): boolean {
  const candidates = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
  const visible = candidates.find((el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const input = visible ?? candidates[0] ?? null;
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, password); else input.value = password;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (!submit) return true;
  const form = input.form;
  const btn = (
    form?.querySelector('button[type="submit"], input[type="submit"]') ||
    document.querySelector('button[type="submit"], input[type="submit"]') ||
    form?.querySelector('button') ||
    document.querySelector('button')
  ) as HTMLElement | null;
  if (btn) { btn.click(); return true; }
  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
  return true;
}

/** Injectable source: evaluates to a boolean (login form present?). */
export function probeCode(): string {
  return `(${hasVisiblePasswordField.toString()})()`;
}

/** Injectable source: evaluates to a boolean (password input found?). */
export function fillCode(password: string, submit: boolean): string {
  return `(${fillLogin.toString()})(${JSON.stringify(password)}, ${submit})`;
}

export const PROBE_ATTEMPTS = 8;
export const PROBE_INTERVAL_MS = 250; // ~2s total detection window
export const FAIL_WINDOW_MS = 3000;   // "still on login" => failed sign-in

export interface AutofillState { submittedThisSession: boolean; }
export type AutofillAction = 'skip' | 'fill-and-submit' | 'fill-only';

export function autofillDecision(state: AutofillState, formPresent: boolean): AutofillAction {
  if (!formPresent) return 'skip';
  return state.submittedThisSession ? 'fill-only' : 'fill-and-submit';
}

export interface AutofillDeps {
  runJs(code: string): Promise<unknown>;
  getPassword(): string | null;
  notifyFailure(): void;
  delay(ms: number): Promise<void>;
}

export async function runAutofill(deps: AutofillDeps, state: AutofillState): Promise<void> {
  const password = deps.getPassword();
  if (password == null) return; // no saved secret for this device

  let present = false;
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    present = (await deps.runJs(probeCode())) === true;
    if (present) break;
    if (i < PROBE_ATTEMPTS - 1) await deps.delay(PROBE_INTERVAL_MS);
  }

  const action = autofillDecision(state, present);
  if (action === 'skip') return;

  if (action === 'fill-only') {
    await deps.runJs(fillCode(password, false)); // fill, do NOT resubmit
    deps.notifyFailure();
    return;
  }

  // fill-and-submit
  await deps.runJs(fillCode(password, true));
  state.submittedThisSession = true;
  await deps.delay(FAIL_WINDOW_MS);
  const stillLogin = (await deps.runJs(probeCode())) === true;
  if (stillLogin) deps.notifyFailure(); // failed sign-in — safety valve blocks any resubmit
}
