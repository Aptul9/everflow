import { createRequire } from 'node:module';
import { NativeError, win32Ffi } from './kernel.ts';

export interface ComBindings {
  initialize(): number;
  uninitialize(): void;
  active(clsid: string): { hresult: number; pointer: bigint | null };
  queryDispatch(pointer: bigint): { hresult: number; pointer: bigint | null };
  releasePointer(pointer: bigint): void;
  wrapDispatch(pointer: bigint): any;
  releaseObject(object: any): void;
  points(object: any): any[];
  releasePoint?(point: any): void;
  pump(): void;
}

const require = createRequire(import.meta.url);
let native: ComBindings | undefined;
function comBindings(): ComBindings {
  if (native) return native;
  const koffi = win32Ffi();
  const winax = require('winax');
  const ole = koffi.load('ole32.dll'), automation = koffi.load('oleaut32.dll');
  const GUID = koffi.struct('DispatcherGuid', { a: 'uint32_t', b: 'uint16_t', c: 'uint16_t', d: koffi.array('uint8_t', 8) });
  if (koffi.sizeof(GUID) !== 16) throw new NativeError('com.abi-layout');
  const initialize = ole.func('long __stdcall CoInitializeEx(void *reserved, uint32_t flags)');
  const uninitialize = ole.func('void __stdcall CoUninitialize()');
  const active = automation.func('long __stdcall GetActiveObject(const DispatcherGuid *clsid, void *reserved, _Out_ void **result)');
  const query = koffi.proto('long __stdcall DispatcherQueryInterface(void *self, const DispatcherGuid *iid, _Out_ void **result)');
  const release = koffi.proto('uint32_t __stdcall DispatcherRelease(void *self)');
  const guid = (value: string) => {
    const [a, b, c, d, e] = value.split('-');
    return { a: Number.parseInt(a!, 16), b: Number.parseInt(b!, 16), c: Number.parseInt(c!, 16), d: Buffer.from(d! + e!, 'hex') };
  };
  const method = (pointer: bigint, offset: number) => koffi.decode(BigInt(koffi.decode(pointer, 'void *')) + BigInt(offset * 8), 'void *');
  const api: ComBindings = {
    initialize: () => initialize(null, 2), uninitialize,
    active: (clsid) => { const result: (bigint | null)[] = [null]; const hresult = active(guid(clsid), null, result); return { hresult, pointer: result[0] ?? null }; },
    queryDispatch: (pointer) => {
      const result: (bigint | null)[] = [null]; const hresult = koffi.call(method(pointer, 0), query, pointer, guid('00020400-0000-0000-C000-000000000046'), result);
      return { hresult, pointer: result[0] ?? null };
    },
    releasePointer: (pointer) => { koffi.call(method(pointer, 2), release, pointer); },
    wrapDispatch: (pointer) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(pointer); return new winax.Object(bytes); },
    // winax3.6.10 has no safe point-disposal API. No releasePoint capability is advertised.
    releaseObject: (object) => { winax.release(object); }, points: (object) => winax.getConnectionPoints(object), pump: () => { winax.peekAndDispatchMessages(); },
  };
  native = api;
  return api;
}

export function createComSession(input?: ComBindings) {
  const api = input ?? comBindings();
  const initialized = api.initialize();
  if (initialized < 0) throw new NativeError('com.initialize', initialized >>> 0);
  const objects = new Set<any>();
  const pointOwners = new Set<any>();
  const subscriptions: { point: any; cookie: number; sink: any }[] = [];
  let closed = false;
  const track = <T>(object: T): T => {
    if (closed) throw new NativeError('com.closed');
    if (object && (typeof object === 'object' || typeof object === 'function')) objects.add(object);
    return object;
  };
  const release = (object: any) => {
    if (!objects.has(object)) throw new NativeError('com.unowned');
    api.releaseObject(object); objects.delete(object);
  };
  const releasePoint = (point: any) => {
    if (!pointOwners.has(point)) throw new NativeError('com.unowned-point');
    api.releasePoint!(point); pointOwners.delete(point);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    let failed = false;
    for (const { point, cookie } of subscriptions.splice(0).reverse()) {
      try { point.unadvise(cookie); } catch { failed = true; }
    }
    for (const point of [...pointOwners].reverse()) {
      try { releasePoint(point); } catch { failed = true; }
    }
    for (const object of [...objects].reverse()) {
      try { release(object); } catch { failed = true; }
    }
    try { api.uninitialize(); } catch { failed = true; }
    if (failed) throw new NativeError('com.cleanup');
  };
  return {
    track, release,
    scope() {
      const local = new Set<any>();
      return {
        use<T>(object: T): T { track(object); if (objects.has(object)) local.add(object); return object; },
        [Symbol.dispose]() {
          let failed = false;
          for (const object of [...local].reverse()) if (objects.has(object)) { try { release(object); } catch { failed = true; } }
          local.clear();
          if (failed) throw new NativeError('com.cleanup');
        },
      };
    },
    attachOutlook(): { object: any; hresult: string } {
      if (closed) throw new NativeError('com.closed');
      const active = api.active('0006F03A-0000-0000-C000-000000000046');
      const hresult = '0x' + (active.hresult >>> 0).toString(16);
      if (active.hresult < 0) {
        if (active.pointer) api.releasePointer(active.pointer);
        if ((active.hresult >>> 0) === 0x800401e3) return { object: null, hresult };
        throw new NativeError('com.attach', active.hresult >>> 0);
      }
      if (!active.pointer) throw new NativeError('com.null-interface');
      let dispatch: bigint | null = null;
      try {
        const result = api.queryDispatch(active.pointer);
        dispatch = result.pointer;
        if (result.hresult < 0) throw new NativeError('com.query-interface', result.hresult >>> 0);
        if (!dispatch) throw new NativeError('com.null-interface');
        let object: any;
        try { object = api.wrapDispatch(dispatch); } catch { throw new NativeError('com.wrap-dispatch'); }
        if (!object || typeof object !== 'object' && typeof object !== 'function') throw new NativeError('com.wrap-dispatch');
        // The Buffer constructor uses CComPtr::Attach. winax owns this reference now.
        dispatch = null;
        return { object: track(object), hresult };
      } finally {
        try { if (dispatch) api.releasePointer(dispatch); }
        finally { api.releasePointer(active.pointer); }
      }
    },
    subscribeNewMail(object: any, listener: (ids: string) => void): boolean {
      if (closed) throw new NativeError('com.closed');
      if (typeof api.releasePoint !== 'function') return false;
      let points: any[];
      try { points = api.points(object); } catch { return false; }
      const acquired = new Set(points);
      for (const point of acquired) pointOwners.add(point);
      let selected: any;
      try {
        for (const point of acquired) {
          try {
            if (!point.getMethods().includes('NewMailEx')) continue;
            const sink = { NewMailEx: (ids: unknown) => { if (typeof ids === 'string') listener(ids); } };
            const cookie = point.advise(sink) as number;
            if (!Number.isInteger(cookie) || cookie <= 0) throw new NativeError('com.event-cookie');
            subscriptions.push({ point, cookie, sink }); selected = point;
            return true;
          } catch { /* Polling remains authoritative when connection points are unavailable. */ }
        }
        return false;
      } finally {
        let failed = false;
        for (const point of acquired) if (point !== selected) { try { releasePoint(point); } catch { failed = true; } }
        if (failed) throw new NativeError('com.cleanup');
      }
    },
    pump() { if (closed) throw new NativeError('com.closed'); api.pump(); },
    close,
    [Symbol.dispose]: close,
  };
}
