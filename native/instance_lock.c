#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <node_api.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define SERVICE_PIPE_PREFIX L"\\\\.\\pipe\\UniversalCmsAI.HttpService.v1."
#define MAX_PIPE_NAME 240

static HANDLE owner_pipe = INVALID_HANDLE_VALUE;

static napi_value throw_lock_error(napi_env env, const char *code, const char *message, DWORD win32_error) {
  napi_value message_value;
  napi_value error_value;
  napi_value code_value;
  napi_value win32_value;
  char safe_message[192];

  if (win32_error != ERROR_SUCCESS) {
    (void)snprintf(safe_message, sizeof(safe_message), "%s (Windows error %lu).", message, (unsigned long)win32_error);
    message_value = NULL;
    (void)napi_create_string_utf8(env, safe_message, NAPI_AUTO_LENGTH, &message_value);
  } else {
    (void)napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  }
  (void)napi_create_error(env, NULL, message_value, &error_value);
  (void)napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  (void)napi_set_named_property(env, error_value, "code", code_value);
  if (win32_error != ERROR_SUCCESS) {
    (void)napi_create_uint32(env, (uint32_t)win32_error, &win32_value);
    (void)napi_set_named_property(env, error_value, "win32Code", win32_value);
  }
  (void)napi_throw(env, error_value);
  return NULL;
}

static BOOL make_pipe_identity(WCHAR *pipe_name, size_t pipe_name_count, const WCHAR *test_suffix) {
  HANDLE token = NULL;
  DWORD token_bytes = 0;
  TOKEN_USER *token_user = NULL;
  BOOL success = FALSE;
  size_t used;

  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return FALSE;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &token_bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || token_bytes == 0) goto cleanup;
  token_user = (TOKEN_USER *)malloc(token_bytes);
  if (token_user == NULL) goto cleanup;
  if (!GetTokenInformation(token, TokenUser, token_user, token_bytes, &token_bytes)) goto cleanup;
  if (!IsValidSid(token_user->User.Sid)) goto cleanup;

  if (wcscpy_s(pipe_name, pipe_name_count, SERVICE_PIPE_PREFIX) != 0) goto cleanup;
  used = wcslen(pipe_name);
  {
    const BYTE *sid_bytes = (const BYTE *)token_user->User.Sid;
    DWORD sid_length = GetLengthSid(token_user->User.Sid);
    DWORD i;
    for (i = 0; i < sid_length; ++i) {
      int written = swprintf_s(pipe_name + used, pipe_name_count - used, L"%02X", sid_bytes[i]);
      if (written != 2) goto cleanup;
      used += 2;
    }
  }
  if (test_suffix != NULL) {
    if (used + 1 >= pipe_name_count) goto cleanup;
    pipe_name[used++] = L'.';
    if (wcscat_s(pipe_name + used, pipe_name_count - used, test_suffix) != 0) goto cleanup;
  }
  success = TRUE;

cleanup:
  if (token_user != NULL) free(token_user);
  if (token != NULL) CloseHandle(token);
  return success;
}

static BOOL make_security_descriptor(PSECURITY_DESCRIPTOR *descriptor, LPWSTR *sid_text) {
  HANDLE token = NULL;
  DWORD token_bytes = 0;
  TOKEN_USER *token_user = NULL;
  BOOL success = FALSE;
  WCHAR sddl[256];

  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &token_bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || token_bytes == 0) goto cleanup;
  token_user = (TOKEN_USER *)malloc(token_bytes);
  if (token_user == NULL) goto cleanup;
  if (!GetTokenInformation(token, TokenUser, token_user, token_bytes, &token_bytes)) goto cleanup;
  if (!IsValidSid(token_user->User.Sid)) goto cleanup;
  if (!ConvertSidToStringSidW(token_user->User.Sid, sid_text)) goto cleanup;
  if (swprintf_s(sddl, _countof(sddl), L"D:P(A;;GA;;;SY)(A;;GA;;;%s)", *sid_text) < 0) goto cleanup;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, NULL)) goto cleanup;
  success = TRUE;

cleanup:
  if (token_user != NULL) free(token_user);
  if (token != NULL) CloseHandle(token);
  return success;
}

static napi_value acquire_pipe(napi_env env, const WCHAR *test_suffix) {
  WCHAR pipe_name[MAX_PIPE_NAME];
  PSECURITY_DESCRIPTOR descriptor = NULL;
  LPWSTR sid_text = NULL;
  SECURITY_ATTRIBUTES attributes;
  HANDLE pipe;
  DWORD error;
  napi_value result;

  if (owner_pipe != INVALID_HANDLE_VALUE) {
    (void)napi_get_boolean(env, TRUE, &result);
    return result;
  }
  if (!make_pipe_identity(pipe_name, _countof(pipe_name), test_suffix)) {
    return throw_lock_error(env, "INSTANCE_LOCK_IDENTITY_FAILED", "Could not determine the current Windows user identity for service ownership", GetLastError());
  }
  if (!make_security_descriptor(&descriptor, &sid_text)) {
    DWORD security_error = GetLastError();
    if (sid_text != NULL) LocalFree(sid_text);
    if (descriptor != NULL) LocalFree(descriptor);
    return throw_lock_error(env, "INSTANCE_LOCK_SECURITY_FAILED", "Could not configure access control for service ownership", security_error);
  }

  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = descriptor;
  attributes.bInheritHandle = FALSE;
  pipe = CreateNamedPipeW(
    pipe_name,
    PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1,
    0,
    0,
    0,
    &attributes);
  error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  if (sid_text != NULL) LocalFree(sid_text);
  if (descriptor != NULL) LocalFree(descriptor);
  if (pipe == INVALID_HANDLE_VALUE) {
    if (error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY) {
      return throw_lock_error(env, "INSTANCE_ALREADY_RUNNING", "Another service instance already owns this Windows user service identity", ERROR_SUCCESS);
    }
    return throw_lock_error(env, "INSTANCE_LOCK_CREATE_FAILED", "Could not acquire Windows service ownership", error);
  }

  owner_pipe = pipe;
  (void)napi_get_boolean(env, TRUE, &result);
  return result;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
  (void)info;
  return acquire_pipe(env, NULL);
}

#ifdef INSTANCE_LOCK_TEST_ADDON
static napi_value acquire_for_test(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_valuetype type;
  char suffix[65];
  size_t length = 0;
  size_t i;
  WCHAR wide_suffix[65];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok || argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    return throw_lock_error(env, "INSTANCE_LOCK_TEST_ID_INVALID", "A test-only ownership suffix is required", ERROR_SUCCESS);
  }
  if (napi_get_value_string_utf8(env, argv[0], suffix, sizeof(suffix), &length) != napi_ok || length == 0 || length > 64) {
    return throw_lock_error(env, "INSTANCE_LOCK_TEST_ID_INVALID", "The test-only ownership suffix is invalid", ERROR_SUCCESS);
  }
  for (i = 0; i < length; ++i) {
    const char c = suffix[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) {
      return throw_lock_error(env, "INSTANCE_LOCK_TEST_ID_INVALID", "The test-only ownership suffix is invalid", ERROR_SUCCESS);
    }
    wide_suffix[i] = (WCHAR)c;
  }
  wide_suffix[length] = L'\0';
  return acquire_pipe(env, wide_suffix);
}
#endif

static napi_value release(napi_env env, napi_callback_info info) {
  napi_value result;
  (void)info;
  if (owner_pipe == INVALID_HANDLE_VALUE) {
    (void)napi_get_undefined(env, &result);
    return result;
  }
  if (!CloseHandle(owner_pipe)) {
    return throw_lock_error(env, "INSTANCE_LOCK_RELEASE_FAILED", "Windows could not release service ownership; the lease remains held for retry", GetLastError());
  }
  owner_pipe = INVALID_HANDLE_VALUE;
  (void)napi_get_undefined(env, &result);
  return result;
}

static napi_value is_held(napi_env env, napi_callback_info info) {
  napi_value result;
  (void)info;
  (void)napi_get_boolean(env, owner_pipe != INVALID_HANDLE_VALUE, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  (void)napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &function);
  (void)napi_set_named_property(env, exports, "acquire", function);
  (void)napi_create_function(env, "release", NAPI_AUTO_LENGTH, release, NULL, &function);
  (void)napi_set_named_property(env, exports, "release", function);
  (void)napi_create_function(env, "isHeld", NAPI_AUTO_LENGTH, is_held, NULL, &function);
  (void)napi_set_named_property(env, exports, "isHeld", function);
#ifdef INSTANCE_LOCK_TEST_ADDON
  (void)napi_create_function(env, "acquireForTest", NAPI_AUTO_LENGTH, acquire_for_test, NULL, &function);
  (void)napi_set_named_property(env, exports, "acquireForTest", function);
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
