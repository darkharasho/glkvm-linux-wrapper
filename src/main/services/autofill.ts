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
  const input = document.querySelector('input[type="password"]') as HTMLInputElement | null;
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
