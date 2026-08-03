// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { hasVisiblePasswordField, fillLogin, probeCode, fillCode } from '../../src/main/services/autofill';

// jsdom has no layout engine, so getBoundingClientRect returns zeros. Stub it to a
// visible box for elements we consider "shown".
function makeVisible(el: Element): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('autofill DOM probe', () => {
  it('detects a visible password field', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    makeVisible(document.querySelector('input')!);
    expect(hasVisiblePasswordField()).toBe(true);
  });

  it('ignores a display:none password field', () => {
    document.body.innerHTML = `<input type="password" style="display:none">`;
    // rect stays zero-size (hidden) -> not visible
    expect(hasVisiblePasswordField()).toBe(false);
  });

  it('returns false when there is no password field', () => {
    document.body.innerHTML = `<input type="text">`;
    expect(hasVisiblePasswordField()).toBe(false);
  });
});

describe('autofill fill', () => {
  it('fills the value, dispatches input+change, and clicks submit when submit=true', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    makeVisible(input);
    let inputFired = false, changeFired = false, clicked = false;
    input.addEventListener('input', () => { inputFired = true; });
    input.addEventListener('change', () => { changeFired = true; });
    document.querySelector('button')!.addEventListener('click', (e) => { e.preventDefault(); clicked = true; });

    expect(fillLogin('s3cret', true)).toBe(true);
    expect(input.value).toBe('s3cret');
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
    expect(clicked).toBe(true);
  });

  it('fills without clicking submit when submit=false', () => {
    document.body.innerHTML = `<form><input type="password"><button type="submit">Sign in</button></form>`;
    let clicked = false;
    document.querySelector('button')!.addEventListener('click', (e) => { e.preventDefault(); clicked = true; });
    expect(fillLogin('s3cret', false)).toBe(true);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('s3cret');
    expect(clicked).toBe(false);
  });

  it('returns false when there is no password field to fill', () => {
    document.body.innerHTML = `<input type="text">`;
    expect(fillLogin('s3cret', true)).toBe(false);
  });

  it('fills the visible password input, skipping a hidden one that precedes it in the DOM', () => {
    document.body.innerHTML = `
      <input type="password" id="hidden" style="display:none">
      <input type="password" id="visible">
    `;
    const hidden = document.getElementById('hidden') as HTMLInputElement;
    const visible = document.getElementById('visible') as HTMLInputElement;
    // hidden stays zero-rect (jsdom default); make the second one visible
    makeVisible(visible);

    expect(fillLogin('s3cret', false)).toBe(true);
    expect(visible.value).toBe('s3cret');
    expect(hidden.value).toBe('');
  });
});

describe('injectable code builders', () => {
  it('probeCode is a self-invoking expression', () => {
    expect(probeCode()).toContain('hasVisiblePasswordField');
    expect(probeCode().trim().startsWith('(')).toBe(true);
  });
  it('fillCode embeds the password as a JSON-escaped string and the submit flag', () => {
    const code = fillCode('a"b', true);
    expect(code).toContain(JSON.stringify('a"b')); // safely escaped
    expect(code).toContain(', true)');
  });
});
