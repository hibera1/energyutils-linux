// eu_native.cc — нативный модуль защиты EnergyUtils (N-API).
// Кросс-платформенная версия (Windows + Linux via #ifdef).
// Ключи НЕ экспортируются наружу: расшифровка мода/DLL целиком внутри C++.
// HWID-сид и анти-отладка отличаются по платформе:
//   - Windows: серийник тома "C:\" + CPUID, IsDebuggerPresent / GetNtGlobalFlag / rdtsc
//   - Linux:   /etc/machine-id (+hostname) + rdtsc, TracerPid в /proc/self/status / rdtsc
#include <node_api.h>
#include <cstring>
#include <cstdint>
#include <cstdio>

#ifdef _WIN32
  #include <windows.h>
  #include <psapi.h>
  #include <intrin.h>
#else
  #include <fstream>
  #include <string>
  #include <unistd.h>
  #include <fcntl.h>
  // rdtsc на x86_64 через inline asm
  static inline uint64_t rdtsc64(void) {
    unsigned int lo = 0, hi = 0;
    __asm__ __volatile__("rdtsc" : "=a"(lo), "=d"(hi));
    return ((uint64_t)hi << 32) | (uint64_t)lo;
  }
#endif

#define UNUSED(x) (void)(x)

// ── Внутренние ключи (не отдаются из JS) ──
static const uint8_t kModKey[32] = {
  0x7A,0x3F,0xC1,0x9B,0x52,0xE4,0x0D,0x38,
  0xF6,0x2B,0xA8,0x74,0x1C,0x95,0xE0,0x63,
  0x47,0x8D,0x1A,0xBE,0x36,0xF9,0x5C,0x02,
  0xA7,0xE9,0x4B,0xD0,0x6E,0x85,0x13,0xC7
};
static const uint8_t kDllXor = 0x2F;

static uint32_t fnv1a(const char* s, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) { h ^= (uint8_t)s[i]; h *= 16777619u; }
  return h;
}

// ── HWID-энтропия ──
#ifdef _WIN32
static uint32_t hwidSeed(void) {
  char vol[64] = {0};
  GetVolumeInformationA("C:\\", nullptr, 0, nullptr, nullptr, nullptr, vol, sizeof(vol));
  uint32_t seed = fnv1a(vol, strnlen(vol, sizeof(vol)));
  int regs[4] = {0};
  __cpuidex(regs, 1, 0);
  seed ^= (uint32_t)regs[3] + ((uint32_t)regs[1] << 1);
  return seed;
}
#else
static uint32_t hwidSeed(void) {
  // Читаем /etc/machine-id (устойчивый идентификатор хоста), фолбэк hostname.
  char buf[64] = {0};
  size_t n = 0;
  std::ifstream mid("/etc/machine-id");
  if (mid.is_open()) { mid.read(buf, 63); n = mid.gcount(); mid.close(); if (n > 0) while (n>0 && (uint8_t)buf[n-1] <= 32) buf[--n]=0; }
  if (n == 0) {
    n = (size_t)gethostname(buf, 63); if (n > 63) n = 63;
  }
  return fnv1a(buf, n);
}
#endif

// ── Анти-отладка: пассивные проверки ──
#ifdef _WIN32
static bool debuggerActive(void) {
  if (IsDebuggerPresent()) return true;
  HMODULE k32 = GetModuleHandleA("kernel32.dll");
  if (k32) {
    typedef DWORD (WINAPI *FnFlag)(void);
    FnFlag f = (FnFlag)GetProcAddress(k32, "GetNtGlobalFlag");
    if (f && ((f() & 0x70) == 0x70)) return true;
  }
  uint64_t t1 = __rdtsc(); uint64_t t2 = __rdtsc();
  return (t2 - t1 > 30000);
}
#else
static bool debuggerActive(void) {
  // TracerPid отличен от 0 → за нами следит отладчик/трассировщик.
  std::ifstream st("/proc/self/status");
  std::string line;
  while (std::getline(st, line)) {
    if (line.compare(0, 9, "TracerPid") == 0) {
      // ищем число после ':'
      size_t p = line.find(':');
      if (p != std::string::npos) {
        long val = 0;
        for (size_t i = p+1; i < line.size(); i++) {
          char c = line[i];
          if (c >= '0' && c <= '9') val = val*10 + (c-'0');
        }
        if (val != 0) return true;
      }
      break;
    }
  }
  uint64_t t1 = rdtsc64(); uint64_t t2 = rdtsc64();
  return (t2 - t1 > 30000);
}
#endif

// ── Расшифровка (чистый XOR — стабилен на всех машинах). HWID не искажает байты ──
static void decodeStream(const uint8_t* src, uint8_t* dst, size_t len) {
  for (size_t i = 0; i < len; i++) dst[i] = src[i] ^ kModKey[i & 31];
}
static void decodeStreamBasic(const uint8_t* src, uint8_t* dst, size_t len) {
  for (size_t i = 0; i < len; i++) dst[i] = src[i] ^ kDllXor;
}

static napi_value DecodeMod(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || debuggerActive()) { napi_value u; napi_get_undefined(env, &u); return u; }
  bool isBuf = false; napi_is_buffer(env, argv[0], &isBuf);
  if (!isBuf) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* data = nullptr; size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (len < 4) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* m = malloc(len);
  if (!m) { napi_value u; napi_get_undefined(env, &u); return u; }
  decodeStream((const uint8_t*)data, (uint8_t*)m, len);
  napi_value out; napi_create_buffer_copy(env, len, m, nullptr, &out); free(m);
  return out;
}

static napi_value DecodePayload(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || debuggerActive()) { napi_value u; napi_get_undefined(env, &u); return u; }
  bool isBuf = false; napi_is_buffer(env, argv[0], &isBuf);
  if (!isBuf) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* data = nullptr; size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (len < 4) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* m = malloc(len);
  if (!m) { napi_value u; napi_get_undefined(env, &u); return u; }
  decodeStreamBasic((const uint8_t*)data, (uint8_t*)m, len);
  napi_value out; napi_create_buffer_copy(env, len, m, nullptr, &out); free(m);
  return out;
}

static napi_value EncodeMod(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* data = nullptr; size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (len < 4) { napi_value u; napi_get_undefined(env, &u); return u; }
  void* m = malloc(len);
  if (!m) { napi_value u; napi_get_undefined(env, &u); return u; }
  for (size_t i = 0; i < len; i++) ((uint8_t*)m)[i] = ((const uint8_t*)data)[i] ^ kModKey[i & 31];
  napi_value out; napi_create_buffer_copy(env, len, m, nullptr, &out); free(m);
  return out;
}

static napi_value HwidInfo(napi_env env, napi_callback_info info) {
  UNUSED(info);
  char buf[64];
  sprintf(buf, "EUS-%08X", (unsigned)hwidSeed());
  napi_value out; napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value IsDebuggerStatus(napi_env env, napi_callback_info info) {
  UNUSED(info);
  napi_value out; napi_get_boolean(env, debuggerActive(), &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descs[] = {
    { "decodeMod",       0, DecodeMod,        0, nullptr, nullptr, napi_default, 0 },
    { "encodeMod",       0, EncodeMod,        0, nullptr, nullptr, napi_default, 0 },
    { "decodePayload",   0, DecodePayload,    0, nullptr, nullptr, napi_default, 0 },
    { "hwidInfo",        0, HwidInfo,         0, nullptr, nullptr, napi_default, 0 },
    { "isDebugger",      0, IsDebuggerStatus, 0, nullptr, nullptr, napi_default, 0 },
  };
  napi_define_properties(env, exports, 5, descs);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)