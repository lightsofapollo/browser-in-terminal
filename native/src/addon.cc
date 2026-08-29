// termbridge — POSIX shared memory + IOSurface readback for streaming Chromium frames
// into a kitty-graphics terminal.
//
// Two capabilities Node cannot do on its own:
//   1. shm_open/mmap, so we can hand the terminal a shared-memory object (kitty `t=s`)
//      instead of pushing megabytes of base64 through the PTY.
//   2. Lock the IOSurface behind Electron's offscreen shared texture and convert its
//      BGRA pixels straight into that shared memory. On Apple silicon the surface is
//      CPU-addressable, so this needs no Metal and no GPU readback.

#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>

#include <errno.h>
#include <termios.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <IOSurface/IOSurface.h>
#endif

namespace {

// Create a POSIX shared-memory object of `size`, map it, hand the mapping to `fill`, then unmap.
// The object itself stays alive until whoever reads it unlinks it (the terminal does, for kitty t=s).
// Electron forbids external Buffers, so the mapping is never exposed to JavaScript: everything that
// touches it happens here, which also removes a copy.
template <typename Fill>
bool WriteShm(const std::string& name, size_t size, Fill fill, std::string* error) {
  shm_unlink(name.c_str());  // a stale object from a crashed run would make O_EXCL fail
  int fd = shm_open(name.c_str(), O_CREAT | O_RDWR | O_EXCL, 0600);
  if (fd < 0) {
    *error = std::string("shm_open failed: ") + strerror(errno);
    return false;
  }
  if (ftruncate(fd, static_cast<off_t>(size)) != 0) {
    *error = std::string("ftruncate failed: ") + strerror(errno);
    close(fd);
    shm_unlink(name.c_str());
    return false;
  }
  void* address = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (address == MAP_FAILED) {
    *error = std::string("mmap failed: ") + strerror(errno);
    shm_unlink(name.c_str());
    return false;
  }
  fill(static_cast<uint8_t*>(address));
  munmap(address, size);
  return true;
}

// redirectStderr(path) -> void
// Chromium logs from C++ straight to file descriptor 2. While we own the screen, anything written
// there lands in the middle of our images and corrupts the display — overriding process.stderr in
// JavaScript cannot stop it, because the writes never pass through Node. Only dup2 does.
// terminalIsRaw() -> boolean
// Node caches isRaw as its own flag rather than reading the terminal, so if anything else puts the
// tty back into cooked mode Node still believes it is raw — and the screen fills with the echoes
// of the very escapes we asked the terminal to send. Ask the terminal itself.
Napi::Value TerminalIsRaw(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  struct termios attrs;
  if (tcgetattr(STDIN_FILENO, &attrs) != 0) {
    return Napi::Boolean::New(env, true);  // cannot tell; do not thrash
  }
  const bool echoing = (attrs.c_lflag & ECHO) != 0;
  const bool canonical = (attrs.c_lflag & ICANON) != 0;
  return Napi::Boolean::New(env, !echoing && !canonical);
}

Napi::Value RedirectStderr(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "redirectStderr(path: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string path = info[0].As<Napi::String>().Utf8Value();
  int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) {
    Napi::Error::New(env, std::string("open failed: ") + strerror(errno))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (dup2(fd, STDERR_FILENO) < 0) {
    int saved = errno;
    close(fd);
    Napi::Error::New(env, std::string("dup2 failed: ") + strerror(saved))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  close(fd);
  return env.Undefined();
}

Napi::Value UnlinkShm(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() >= 1 && info[0].IsString()) {
    shm_unlink(info[0].As<Napi::String>().Utf8Value().c_str());
  }
  return env.Undefined();
}

// ---------------------------------------------------------------- pixel conversion

// Little-endian: BGRA bytes read as uint32 are 0xAARRGGBB; RGBA bytes want 0xAABBGGRR,
// so red and blue swap while green and alpha stay put.
// Pack BGRA (or RGBA) down to 3-byte RGB. Alpha is constant for an opaque page, so dropping it
// removes a quarter of every byte we move AND a quarter of what the terminal has to upload.
inline void PackRow(const uint32_t* src, uint8_t* dst, size_t count, bool swap) {
  for (size_t i = 0; i < count; i++) {
    uint32_t v = src[i];
    uint8_t b0 = static_cast<uint8_t>(v & 0xff);
    uint8_t g = static_cast<uint8_t>((v >> 8) & 0xff);
    uint8_t b2 = static_cast<uint8_t>((v >> 16) & 0xff);
    dst[i * 3] = swap ? b2 : b0;
    dst[i * 3 + 1] = g;
    dst[i * 3 + 2] = swap ? b0 : b2;
  }
}

inline void ConvertRow(const uint32_t* src, uint32_t* dst, size_t count) {
  for (size_t i = 0; i < count; i++) {
    uint32_t v = src[i];
    dst[i] = (v & 0xff00ff00u) | ((v & 0x00ff0000u) >> 16) | ((v & 0x000000ffu) << 16);
  }
}

// convertRect(src: Buffer, srcStrideBytes, x, y, width, height, dst: Buffer, swapRB: boolean)
Napi::Value ConvertRect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 8) {
    Napi::TypeError::New(env, "convertRect(src, srcStride, x, y, w, h, dst, swapRB)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> src = info[0].As<Napi::Buffer<uint8_t>>();
  size_t stride = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  int64_t x = info[2].As<Napi::Number>().Int64Value();
  int64_t y = info[3].As<Napi::Number>().Int64Value();
  int64_t w = info[4].As<Napi::Number>().Int64Value();
  int64_t h = info[5].As<Napi::Number>().Int64Value();
  Napi::Buffer<uint8_t> dst = info[6].As<Napi::Buffer<uint8_t>>();
  bool swap = info[7].ToBoolean().Value();

  if (w <= 0 || h <= 0) return env.Undefined();
  size_t needed = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
  if (dst.Length() < needed) {
    Napi::RangeError::New(env, "destination buffer too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t last_row_end = static_cast<size_t>(y + h - 1) * stride + static_cast<size_t>(x + w) * 4;
  if (last_row_end > src.Length()) {
    Napi::RangeError::New(env, "source rect out of bounds").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const uint8_t* src_base = src.Data();
  uint8_t* dst_base = dst.Data();
  for (int64_t row = 0; row < h; row++) {
    const uint8_t* s = src_base + static_cast<size_t>(y + row) * stride + static_cast<size_t>(x) * 4;
    uint8_t* d = dst_base + static_cast<size_t>(row) * static_cast<size_t>(w) * 4;
    if (swap) {
      ConvertRow(reinterpret_cast<const uint32_t*>(s), reinterpret_cast<uint32_t*>(d),
                 static_cast<size_t>(w));
    } else {
      memcpy(d, s, static_cast<size_t>(w) * 4);
    }
  }
  return env.Undefined();
}

// ---------------------------------------------------------------- tile hashing

// FNV-1a over 32-bit pixels. Chromium reports a single dirty rect — the union of every change —
// so a page with a clock in one corner and a caret in another reports nearly the whole viewport.
// Hashing tiles inside that rect recovers the real damage: only tiles whose pixels actually
// changed get transmitted.
static inline double HashRect(const uint8_t* base, size_t stride, int64_t x, int64_t y,
                              int64_t w, int64_t h) {
  uint64_t hash = 1469598103934665603ULL;
  for (int64_t row = 0; row < h; row++) {
    const uint32_t* p =
        reinterpret_cast<const uint32_t*>(base + static_cast<size_t>(y + row) * stride +
                                          static_cast<size_t>(x) * 4);
    for (int64_t i = 0; i < w; i++) {
      hash ^= p[i];
      hash *= 1099511628211ULL;
    }
  }
  // Doubles hold 53 bits exactly; drop the low 11 so the value round-trips through JS.
  return static_cast<double>(hash >> 11);
}

// hashTilesBitmap(src, stride, tiles: Int32Array [x,y,w,h]*n, out: Float64Array)
Napi::Value HashTilesBitmap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "hashTilesBitmap(src, stride, tiles, out)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> src = info[0].As<Napi::Buffer<uint8_t>>();
  size_t stride = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  Napi::Int32Array tiles = info[2].As<Napi::Int32Array>();
  Napi::Float64Array out = info[3].As<Napi::Float64Array>();
  size_t count = tiles.ElementLength() / 4;
  if (out.ElementLength() < count) {
    Napi::RangeError::New(env, "output array too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const uint8_t* base = src.Data();
  for (size_t i = 0; i < count; i++) {
    int64_t x = tiles[i * 4], y = tiles[i * 4 + 1], w = tiles[i * 4 + 2], h = tiles[i * 4 + 3];
    size_t last = static_cast<size_t>(y + h - 1) * stride + static_cast<size_t>(x + w) * 4;
    if (w <= 0 || h <= 0 || last > src.Length()) {
      out[i] = 0;
      continue;
    }
    out[i] = HashRect(base, stride, x, y, w, h);
  }
  return env.Undefined();
}

// ---------------------------------------------------------------- IOSurface

#if defined(__APPLE__)
// shmFromIOSurface(handleBuffer, x, y, w, h, name, swapRB) -> { bytes, surfaceWidth, surfaceHeight }
// Locks the IOSurface behind Electron's offscreen shared texture and converts the requested rect
// directly into a fresh shared-memory object. On Apple silicon the surface is CPU-addressable, so
// this needs no Metal and no GPU readback.
Napi::Value ShmFromIOSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 7) {
    Napi::TypeError::New(env, "shmFromIOSurface(handle, x, y, w, h, name, swapRB)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() < sizeof(void*)) {
    Napi::TypeError::New(env, "handle buffer too small for an IOSurfaceRef").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uintptr_t raw = 0;
  memcpy(&raw, handle.Data(), sizeof(raw));
  IOSurfaceRef surface = reinterpret_cast<IOSurfaceRef>(raw);
  if (surface == nullptr) {
    Napi::Error::New(env, "null IOSurfaceRef").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  int64_t x = info[1].As<Napi::Number>().Int64Value();
  int64_t y = info[2].As<Napi::Number>().Int64Value();
  int64_t w = info[3].As<Napi::Number>().Int64Value();
  int64_t h = info[4].As<Napi::Number>().Int64Value();
  std::string name = info[5].As<Napi::String>().Utf8Value();
  bool swap = info[6].ToBoolean().Value();
  bool pack = info.Length() > 7 && info[7].ToBoolean().Value();

  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    Napi::Error::New(env, "IOSurfaceLock failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t surface_width = IOSurfaceGetWidth(surface);
  size_t surface_height = IOSurfaceGetHeight(surface);
  size_t stride = IOSurfaceGetBytesPerRow(surface);
  const uint8_t* base = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(surface));
  if (base == nullptr) {
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
    Napi::Error::New(env, "IOSurfaceGetBaseAddress returned null").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > static_cast<int64_t>(surface_width)) w = static_cast<int64_t>(surface_width) - x;
  if (y + h > static_cast<int64_t>(surface_height)) h = static_cast<int64_t>(surface_height) - y;
  if (w <= 0 || h <= 0) {
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
    Napi::RangeError::New(env, "empty rect").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  size_t bytes_per_pixel = pack ? 3u : 4u;
  size_t size = static_cast<size_t>(w) * static_cast<size_t>(h) * bytes_per_pixel;
  std::string error;
  bool ok = WriteShm(name, size, [&](uint8_t* dst) {
    for (int64_t row = 0; row < h; row++) {
      const uint8_t* s = base + static_cast<size_t>(y + row) * stride + static_cast<size_t>(x) * 4;
      uint8_t* d = dst + static_cast<size_t>(row) * static_cast<size_t>(w) * bytes_per_pixel;
      if (pack) {
        PackRow(reinterpret_cast<const uint32_t*>(s), d, static_cast<size_t>(w), swap);
      } else if (swap) {
        ConvertRow(reinterpret_cast<const uint32_t*>(s), reinterpret_cast<uint32_t*>(d),
                   static_cast<size_t>(w));
      } else {
        memcpy(d, s, static_cast<size_t>(w) * 4);
      }
    }
  }, &error);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);

  if (!ok) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("bytes", Napi::Number::New(env, static_cast<double>(size)));
  result.Set("surfaceWidth", Napi::Number::New(env, static_cast<double>(surface_width)));
  result.Set("surfaceHeight", Napi::Number::New(env, static_cast<double>(surface_height)));
  return result;
}

#endif

// shmFromBitmap(src, srcStride, x, y, w, h, name, swapRB) -> { bytes }
Napi::Value ShmFromBitmap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 8) {
    Napi::TypeError::New(env, "shmFromBitmap(src, stride, x, y, w, h, name, swapRB)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> src = info[0].As<Napi::Buffer<uint8_t>>();
  size_t stride = static_cast<size_t>(info[1].As<Napi::Number>().Int64Value());
  int64_t x = info[2].As<Napi::Number>().Int64Value();
  int64_t y = info[3].As<Napi::Number>().Int64Value();
  int64_t w = info[4].As<Napi::Number>().Int64Value();
  int64_t h = info[5].As<Napi::Number>().Int64Value();
  std::string name = info[6].As<Napi::String>().Utf8Value();
  bool swap = info[7].ToBoolean().Value();
  bool pack = info.Length() > 8 && info[8].ToBoolean().Value();

  if (w <= 0 || h <= 0) {
    Napi::RangeError::New(env, "empty rect").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t last_row_end = static_cast<size_t>(y + h - 1) * stride + static_cast<size_t>(x + w) * 4;
  if (last_row_end > src.Length()) {
    Napi::RangeError::New(env, "source rect out of bounds").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const uint8_t* base = src.Data();
  size_t bytes_per_pixel = pack ? 3u : 4u;
  size_t size = static_cast<size_t>(w) * static_cast<size_t>(h) * bytes_per_pixel;
  std::string error;
  bool ok = WriteShm(name, size, [&](uint8_t* dst) {
    for (int64_t row = 0; row < h; row++) {
      const uint8_t* s = base + static_cast<size_t>(y + row) * stride + static_cast<size_t>(x) * 4;
      uint8_t* d = dst + static_cast<size_t>(row) * static_cast<size_t>(w) * bytes_per_pixel;
      if (pack) {
        PackRow(reinterpret_cast<const uint32_t*>(s), d, static_cast<size_t>(w), swap);
      } else if (swap) {
        ConvertRow(reinterpret_cast<const uint32_t*>(s), reinterpret_cast<uint32_t*>(d),
                   static_cast<size_t>(w));
      } else {
        memcpy(d, s, static_cast<size_t>(w) * 4);
      }
    }
  }, &error);
  if (!ok) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("bytes", Napi::Number::New(env, static_cast<double>(size)));
  return result;
}

#if defined(__APPLE__)
// copyIOSurface(handle, x, y, w, h, dst, swapRB) -> void
// Read a rect out of the shared texture into an ordinary Buffer. Used where a JS-visible copy is
// needed rather than a direct write into shared memory.
Napi::Value CopyIOSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 7) {
    Napi::TypeError::New(env, "copyIOSurface(handle, x, y, w, h, dst, swapRB)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() < sizeof(void*)) {
    Napi::TypeError::New(env, "handle buffer too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uintptr_t raw = 0;
  memcpy(&raw, handle.Data(), sizeof(raw));
  IOSurfaceRef surface = reinterpret_cast<IOSurfaceRef>(raw);
  if (surface == nullptr) {
    Napi::Error::New(env, "null IOSurfaceRef").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  int64_t x = info[1].As<Napi::Number>().Int64Value();
  int64_t y = info[2].As<Napi::Number>().Int64Value();
  int64_t w = info[3].As<Napi::Number>().Int64Value();
  int64_t h = info[4].As<Napi::Number>().Int64Value();
  Napi::Buffer<uint8_t> dst = info[5].As<Napi::Buffer<uint8_t>>();
  bool swap = info[6].ToBoolean().Value();

  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    Napi::Error::New(env, "IOSurfaceLock failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t sw = IOSurfaceGetWidth(surface);
  size_t sh = IOSurfaceGetHeight(surface);
  size_t stride = IOSurfaceGetBytesPerRow(surface);
  const uint8_t* base = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(surface));
  if (base != nullptr && w > 0 && h > 0 &&
      x + w <= static_cast<int64_t>(sw) && y + h <= static_cast<int64_t>(sh) &&
      dst.Length() >= static_cast<size_t>(w) * static_cast<size_t>(h) * 4) {
    uint8_t* out = dst.Data();
    for (int64_t row = 0; row < h; row++) {
      const uint8_t* srow = base + static_cast<size_t>(y + row) * stride + static_cast<size_t>(x) * 4;
      uint8_t* drow = out + static_cast<size_t>(row) * static_cast<size_t>(w) * 4;
      if (swap) {
        ConvertRow(reinterpret_cast<const uint32_t*>(srow), reinterpret_cast<uint32_t*>(drow),
                   static_cast<size_t>(w));
      } else {
        memcpy(drow, srow, static_cast<size_t>(w) * 4);
      }
    }
  }
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  return env.Undefined();
}

// hashTilesIOSurface(handle, tiles: Int32Array, out: Float64Array)
// Locks the surface once and hashes every candidate tile, rather than locking per tile.
Napi::Value HashTilesIOSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "hashTilesIOSurface(handle, tiles, out)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() < sizeof(void*)) {
    Napi::TypeError::New(env, "handle buffer too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uintptr_t raw = 0;
  memcpy(&raw, handle.Data(), sizeof(raw));
  IOSurfaceRef surface = reinterpret_cast<IOSurfaceRef>(raw);
  if (surface == nullptr) {
    Napi::Error::New(env, "null IOSurfaceRef").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Int32Array tiles = info[1].As<Napi::Int32Array>();
  Napi::Float64Array out = info[2].As<Napi::Float64Array>();
  size_t count = tiles.ElementLength() / 4;
  if (out.ElementLength() < count) {
    Napi::RangeError::New(env, "output array too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    Napi::Error::New(env, "IOSurfaceLock failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  size_t sw = IOSurfaceGetWidth(surface);
  size_t sh = IOSurfaceGetHeight(surface);
  size_t stride = IOSurfaceGetBytesPerRow(surface);
  const uint8_t* base = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(surface));
  if (base != nullptr) {
    for (size_t i = 0; i < count; i++) {
      int64_t x = tiles[i * 4], y = tiles[i * 4 + 1], w = tiles[i * 4 + 2], h = tiles[i * 4 + 3];
      if (w <= 0 || h <= 0 || x + w > static_cast<int64_t>(sw) || y + h > static_cast<int64_t>(sh)) {
        out[i] = 0;
        continue;
      }
      out[i] = HashRect(base, stride, x, y, w, h);
    }
  }
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  return env.Undefined();
}
#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("unlinkShm", Napi::Function::New(env, UnlinkShm));
  exports.Set("redirectStderr", Napi::Function::New(env, RedirectStderr));
  exports.Set("terminalIsRaw", Napi::Function::New(env, TerminalIsRaw));
  exports.Set("shmFromBitmap", Napi::Function::New(env, ShmFromBitmap));
  exports.Set("hashTilesBitmap", Napi::Function::New(env, HashTilesBitmap));
  exports.Set("convertRect", Napi::Function::New(env, ConvertRect));
#if defined(__APPLE__)
  exports.Set("shmFromIOSurface", Napi::Function::New(env, ShmFromIOSurface));
  exports.Set("hashTilesIOSurface", Napi::Function::New(env, HashTilesIOSurface));
  exports.Set("copyIOSurface", Napi::Function::New(env, CopyIOSurface));
  exports.Set("hasIOSurface", Napi::Boolean::New(env, true));
#else
  exports.Set("hasIOSurface", Napi::Boolean::New(env, false));
#endif
  return exports;
}

}  // namespace

NODE_API_MODULE(termbridge, Init)
