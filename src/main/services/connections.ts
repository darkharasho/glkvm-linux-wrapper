// Stub for Task 8 so ipc.ts compiles independently. Task 10 fills in the real implementation.
export interface ConnectionManager {
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
}
