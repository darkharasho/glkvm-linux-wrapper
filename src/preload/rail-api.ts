export interface RailState {
  mode: 'idle' | 'connected';
  deviceName?: string;
  captureOn?: boolean;
}

export type WinControlAction = 'min' | 'max' | 'close';

export interface RailApi {
  onState(cb: (s: RailState) => void): void;
  back(): void;
  disconnect(): void;
  control(action: WinControlAction): void;
}

declare global {
  interface Window {
    rail: RailApi;
  }
}
