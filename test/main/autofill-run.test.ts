import { describe, it, expect } from 'vitest';
import { autofillDecision, runAutofill, type AutofillState, type AutofillDeps } from '../../src/main/services/autofill';

describe('autofillDecision', () => {
  it('skips when no form present', () => {
    expect(autofillDecision({ submittedThisSession: false }, false)).toBe('skip');
  });
  it('fills and submits on first login form', () => {
    expect(autofillDecision({ submittedThisSession: false }, true)).toBe('fill-and-submit');
  });
  it('fills only (no resubmit) after a prior submit — safety valve', () => {
    expect(autofillDecision({ submittedThisSession: true }, true)).toBe('fill-only');
  });
});

// A scripted runJs: returns queued probe results; records fill calls.
function harness(probeResults: boolean[], password: string | null) {
  const calls: string[] = [];
  let probeIdx = 0;
  let failures = 0;
  const deps: AutofillDeps = {
    runJs: async (code) => {
      calls.push(code);
      if (code.includes('hasVisiblePasswordField')) {
        const r = probeResults[Math.min(probeIdx, probeResults.length - 1)];
        probeIdx++;
        return r;
      }
      return true; // fillCode
    },
    getPassword: () => password,
    notifyFailure: () => { failures++; },
    delay: async () => {},
  };
  return { deps, calls, failures: () => failures };
}

describe('runAutofill', () => {
  it('does nothing when there is no saved password', async () => {
    const h = harness([true], null);
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.calls.length).toBe(0);
  });

  it('skips (never fills) when no login form appears', async () => {
    const h = harness([false], 'pw');
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.calls.some((c) => c.includes('fillLogin'))).toBe(false);
  });

  it('fills+submits then reports success (form gone after submit)', async () => {
    // probes: first probe true (login present), post-submit probe false (logged in)
    const h = harness([true, false], 'pw');
    const state: AutofillState = { submittedThisSession: false };
    await runAutofill(h.deps, state);
    expect(h.calls.some((c) => c.includes('fillLogin') && c.includes(', true'))).toBe(true);
    expect(state.submittedThisSession).toBe(true);
    expect(h.failures()).toBe(0);
  });

  it('notifies failure when the login form persists after submit', async () => {
    const h = harness([true, true], 'pw'); // present before AND after submit
    await runAutofill(h.deps, { submittedThisSession: false });
    expect(h.failures()).toBe(1);
  });

  it('safety valve: on a resubmit attempt it fills only, never clicks submit, and notifies', async () => {
    const h = harness([true], 'pw');
    await runAutofill(h.deps, { submittedThisSession: true });
    const fillCalls = h.calls.filter((c) => c.includes('fillLogin'));
    expect(fillCalls.length).toBe(1);
    expect(fillCalls[0]).toContain(', false'); // submit=false
    expect(h.failures()).toBe(1);
  });
});
