import { NativeError, win32Ffi } from './kernel.ts';

export interface DpapiBindings {
  transform(input: Buffer, protect: boolean, flags: number): { pointer: bigint | null; size: number };
  copy(pointer: bigint, size: number): Buffer;
  zero(pointer: bigint, size: number): void;
  free(pointer: bigint): boolean;
}

let native: DpapiBindings | undefined;
function dpapiBindings(): DpapiBindings {
  if (native) return native;
  const koffi = win32Ffi(), crypt = koffi.load('crypt32.dll'), kernel = koffi.load('kernel32.dll');
  const blob = koffi.struct('DispatcherDataBlob', { cbData: 'uint32_t', pbData: 'void *' });
  if (koffi.sizeof(blob) !== 16 || koffi.offsetof(blob, 'pbData') !== 8) throw new NativeError('dpapi.abi-layout');
  const protect = crypt.func('int __stdcall CryptProtectData(const DispatcherDataBlob *input, str16 description, const DispatcherDataBlob *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DispatcherDataBlob *output)');
  const unprotect = crypt.func('int __stdcall CryptUnprotectData(const DispatcherDataBlob *input, void *description, const DispatcherDataBlob *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ DispatcherDataBlob *output)');
  const last = kernel.func('uint32_t __stdcall GetLastError()'), free = kernel.func('void *__stdcall LocalFree(void *memory)');
  native = {
    transform(input, protecting, flags) {
      const output: { cbData?: number; pbData?: bigint } = {};
      if (!(protecting ? protect : unprotect)({ cbData: input.length, pbData: input }, null, null, null, null, flags, output)) {
        if (output.pbData) free(output.pbData);
        throw new NativeError('dpapi.transform', last());
      }
      return { pointer: output.pbData ?? null, size: output.cbData ?? -1 };
    },
    copy: (pointer, size) => Buffer.from(new Uint8Array(koffi.view(pointer, size))),
    zero: (pointer, size) => { Buffer.from(koffi.view(pointer, size)).fill(0); },
    free: (pointer) => !free(pointer),
  };
  return native;
}

export function createDpapi(input?: DpapiBindings) {
  // No DLL or user credential access until the adapter is explicitly constructed.
  const api = input ?? dpapiBindings();
  function transform(bytes: Buffer, protect: boolean): Buffer {
    if (bytes.length > 16 * 1024 * 1024) throw new NativeError('dpapi.input-size');
    const clearInput = Buffer.from(bytes);
    let output: { pointer: bigint | null; size: number } | undefined;
    try {
      output = api.transform(clearInput, protect, 1);
      if (!output.pointer || !Number.isSafeInteger(output.size) || output.size < 0 || output.size > 16 * 1024 * 1024) throw new NativeError('dpapi.output-size');
      try { return output.size ? api.copy(output.pointer, output.size) : Buffer.alloc(0); }
      catch { throw new NativeError('dpapi.copy'); }
    } finally {
      clearInput.fill(0);
      if (output?.pointer) {
        try { if (output.size > 0 && output.size <= 16 * 1024 * 1024) api.zero(output.pointer, output.size); }
        finally { if (!api.free(output.pointer)) throw new NativeError('dpapi.cleanup'); }
      }
    }
  }
  return { protect: (bytes: Buffer) => transform(bytes, true), unprotect: (bytes: Buffer) => transform(bytes, false) };
}
