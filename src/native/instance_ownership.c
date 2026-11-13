#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>

#define MAX_IDENTITY_LEN 64
#define PIPE_PREFIX L"\\\\.\\pipe\\squarespace-mcp-owner-"

typedef struct {
    HANDLE hPipe;
    BOOL released;
    char utf8Identity[MAX_IDENTITY_LEN + 1];
    wchar_t wszPipeName[MAX_PATH];
} OwnershipHandleData;

#ifdef _WIN32

static BOOL ValidateAndExtractIdentity(napi_env env, napi_value arg, wchar_t* outWsz, char* outUtf8, size_t maxChars) {
    napi_valuetype valType;
    napi_status status = napi_typeof(env, arg, &valType);
    if (status != napi_ok) return FALSE;

    if (valType == napi_undefined || valType == napi_null) {
        wcscpy_s(outWsz, maxChars, L"default");
        strcpy_s(outUtf8, maxChars, "default");
        return TRUE;
    }

    if (valType != napi_string) {
        return FALSE;
    }

    size_t copied = 0;
    status = napi_get_value_string_utf8(env, arg, outUtf8, maxChars, &copied);
    if (status != napi_ok || copied == 0 || copied >= maxChars) {
        return FALSE;
    }
    outUtf8[copied] = '\0';

    /* Enforce strict project-controlled character set: [a-zA-Z0-9_\-] */
    for (size_t i = 0; i < copied; i++) {
        char c = outUtf8[i];
        if (!((c >= 'a' && c <= 'z') ||
              (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') ||
              c == '_' || c == '-')) {
            return FALSE;
        }
    }

    int wlen = MultiByteToWideChar(CP_UTF8, 0, outUtf8, -1, outWsz, (int)maxChars);
    if (wlen <= 0) {
        return FALSE;
    }

    return TRUE;
}

static BOOL CreateCurrentUserSecurityDescriptor(SECURITY_ATTRIBUTES* psa, PACL* ppAclOut, PSECURITY_DESCRIPTOR* ppSdOut) {
    HANDLE hToken = NULL;
    DWORD dwTokenUserSize = 0;
    PTOKEN_USER pTokenUser = NULL;
    PACL pAcl = NULL;
    PSECURITY_DESCRIPTOR pSD = NULL;
    DWORD cbAcl = 0;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &hToken)) {
        return FALSE;
    }

    if (!GetTokenInformation(hToken, TokenUser, NULL, 0, &dwTokenUserSize) &&
        GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        CloseHandle(hToken);
        return FALSE;
    }

    pTokenUser = (PTOKEN_USER)malloc(dwTokenUserSize);
    if (!pTokenUser) {
        CloseHandle(hToken);
        return FALSE;
    }

    if (!GetTokenInformation(hToken, TokenUser, pTokenUser, dwTokenUserSize, &dwTokenUserSize)) {
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    PSID pUserSid = pTokenUser->User.Sid;
    if (!IsValidSid(pUserSid)) {
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    /* ACL size for one ACCESS_ALLOWED_ACE holding the current user SID */
    cbAcl = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(pUserSid);
    pAcl = (PACL)malloc(cbAcl);
    if (!pAcl) {
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    if (!InitializeAcl(pAcl, cbAcl, ACL_REVISION)) {
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    /* Restrictive DACL: Grant full access strictly to the current user SID */
    if (!AddAccessAllowedAce(pAcl, ACL_REVISION, GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, pUserSid)) {
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    pSD = (PSECURITY_DESCRIPTOR)malloc(SECURITY_DESCRIPTOR_MIN_LENGTH);
    if (!pSD) {
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    if (!InitializeSecurityDescriptor(pSD, SECURITY_DESCRIPTOR_REVISION)) {
        free(pSD);
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    /* Set DACL: bDaclPresent = TRUE, bDaclDefaulted = FALSE */
    if (!SetSecurityDescriptorDacl(pSD, TRUE, pAcl, FALSE)) {
        free(pSD);
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    if (!SetSecurityDescriptorOwner(pSD, pUserSid, FALSE)) {
        free(pSD);
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    if (!SetSecurityDescriptorGroup(pSD, pUserSid, FALSE)) {
        free(pSD);
        free(pAcl);
        free(pTokenUser);
        CloseHandle(hToken);
        return FALSE;
    }

    psa->nLength = sizeof(SECURITY_ATTRIBUTES);
    psa->lpSecurityDescriptor = pSD;
    psa->bInheritHandle = FALSE;

    *ppAclOut = pAcl;
    *ppSdOut = pSD;

    free(pTokenUser);
    CloseHandle(hToken);
    return TRUE;
}

static void OwnershipFinalize(napi_env env, void* finalize_data, void* finalize_hint) {
    OwnershipHandleData* data = (OwnershipHandleData*)finalize_data;
    if (data) {
        if (!data->released && data->hPipe != INVALID_HANDLE_VALUE) {
            CloseHandle(data->hPipe);
            data->hPipe = INVALID_HANDLE_VALUE;
            data->released = TRUE;
        }
        free(data);
    }
}

static napi_value HandleRelease(napi_env env, napi_callback_info info) {
    napi_value jsthis;
    napi_status status = napi_get_cb_info(env, info, NULL, NULL, &jsthis, NULL);
    if (status != napi_ok) return NULL;

    OwnershipHandleData* data = NULL;
    status = napi_unwrap(env, jsthis, (void**)&data);
    if (status != napi_ok || !data) {
        napi_throw_error(env, "EINVAL", "Invalid ownership handle context.");
        return NULL;
    }

    BOOL wasReleased = data->released;
    if (!data->released && data->hPipe != INVALID_HANDLE_VALUE) {
        CloseHandle(data->hPipe);
        data->hPipe = INVALID_HANDLE_VALUE;
        data->released = TRUE;
    }

    napi_value result;
    napi_get_boolean(env, !wasReleased, &result);
    return result;
}

static napi_value HandleIsOwned(napi_env env, napi_callback_info info) {
    napi_value jsthis;
    napi_status status = napi_get_cb_info(env, info, NULL, NULL, &jsthis, NULL);
    if (status != napi_ok) return NULL;

    OwnershipHandleData* data = NULL;
    status = napi_unwrap(env, jsthis, (void**)&data);
    if (status != napi_ok || !data) {
        napi_value res;
        napi_get_boolean(env, false, &res);
        return res;
    }

    napi_value res;
    napi_get_boolean(env, (!data->released && data->hPipe != INVALID_HANDLE_VALUE), &res);
    return res;
}

static napi_value AcquireOwnership(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    if (status != napi_ok) return NULL;

    wchar_t wszIdentity[MAX_IDENTITY_LEN + 1];
    char utf8Identity[MAX_IDENTITY_LEN + 1];

    napi_value identityArg = (argc > 0) ? argv[0] : NULL;
    if (!ValidateAndExtractIdentity(env, identityArg, wszIdentity, utf8Identity, MAX_IDENTITY_LEN + 1)) {
        napi_throw_error(env, "INVALID_OWNERSHIP_IDENTITY",
            "Invalid ownership identity. Identity must be 1-64 characters matching [a-zA-Z0-9_-].");
        return NULL;
    }

    wchar_t fullPipeName[MAX_PATH];
    swprintf_s(fullPipeName, MAX_PATH, L"%s%s", PIPE_PREFIX, wszIdentity);

    SECURITY_ATTRIBUTES sa;
    PACL pAcl = NULL;
    PSECURITY_DESCRIPTOR pSD = NULL;

    if (!CreateCurrentUserSecurityDescriptor(&sa, &pAcl, &pSD)) {
        napi_throw_error(env, "SECURITY_DESCRIPTOR_FAILED",
            "Failed to configure restrictive security descriptor for ownership pipe.");
        return NULL;
    }

    /*
     * Exclusive Windows named-pipe instance creation:
     * - FILE_FLAG_FIRST_PIPE_INSTANCE: fails if not the first instance.
     * - nMaxInstances = 1: enforces single instance globally.
     * - PIPE_REJECT_REMOTE_CLIENTS: rejects remote network clients.
     * - Scoped DACL: restricts access to current Windows user SID.
     */
    HANDLE hPipe = CreateNamedPipeW(
        fullPipeName,
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        512,
        512,
        0,
        &sa
    );

    DWORD dwErr = GetLastError();

    if (pSD) free(pSD);
    if (pAcl) free(pAcl);

    if (hPipe == INVALID_HANDLE_VALUE) {
        if (dwErr == ERROR_ACCESS_DENIED || dwErr == ERROR_ALREADY_EXISTS || dwErr == ERROR_PIPE_BUSY) {
            char errMsg[256];
            snprintf(errMsg, sizeof(errMsg),
                "Another service instance is already running with ownership identity: %s", utf8Identity);
            napi_throw_error(env, "INSTANCE_ALREADY_RUNNING", errMsg);
            return NULL;
        } else {
            char errMsg[256];
            snprintf(errMsg, sizeof(errMsg),
                "Failed to acquire instance ownership pipe (Windows error code: %lu).", dwErr);
            napi_throw_error(env, "INSTANCE_OWNERSHIP_ACQUISITION_FAILED", errMsg);
            return NULL;
        }
    }

    OwnershipHandleData* data = (OwnershipHandleData*)calloc(1, sizeof(OwnershipHandleData));
    if (!data) {
        CloseHandle(hPipe);
        napi_throw_error(env, "ENOMEM", "Failed to allocate memory for ownership handle.");
        return NULL;
    }

    data->hPipe = hPipe;
    data->released = FALSE;
    strcpy_s(data->utf8Identity, sizeof(data->utf8Identity), utf8Identity);
    wcscpy_s(data->wszPipeName, MAX_PATH, fullPipeName);

    napi_value jsHandle;
    status = napi_create_object(env, &jsHandle);
    if (status != napi_ok) {
        CloseHandle(hPipe);
        free(data);
        return NULL;
    }

    napi_value jsIdentity;
    napi_create_string_utf8(env, utf8Identity, NAPI_AUTO_LENGTH, &jsIdentity);
    napi_set_named_property(env, jsHandle, "identity", jsIdentity);

    char utf8PipeName[MAX_PATH * 2];
    WideCharToMultiByte(CP_UTF8, 0, fullPipeName, -1, utf8PipeName, sizeof(utf8PipeName), NULL, NULL);
    napi_value jsPipeName;
    napi_create_string_utf8(env, utf8PipeName, NAPI_AUTO_LENGTH, &jsPipeName);
    napi_set_named_property(env, jsHandle, "pipeName", jsPipeName);

    napi_value fnRelease;
    napi_create_function(env, "release", NAPI_AUTO_LENGTH, HandleRelease, NULL, &fnRelease);
    napi_set_named_property(env, jsHandle, "release", fnRelease);

    napi_value fnIsOwned;
    napi_create_function(env, "isOwned", NAPI_AUTO_LENGTH, HandleIsOwned, NULL, &fnIsOwned);
    napi_set_named_property(env, jsHandle, "isOwned", fnIsOwned);

    status = napi_wrap(env, jsHandle, data, OwnershipFinalize, NULL, NULL);
    if (status != napi_ok) {
        CloseHandle(hPipe);
        free(data);
        return NULL;
    }

    return jsHandle;
}

static napi_value IsSupported(napi_env env, napi_callback_info info) {
    napi_value res;
    napi_get_boolean(env, true, &res);
    return res;
}

static napi_value GetNativeInfo(napi_env env, napi_callback_info info) {
    napi_value res;
    napi_create_object(env, &res);

    napi_value vPlatform;
    napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH, &vPlatform);
    napi_set_named_property(env, res, "platform", vPlatform);

    napi_value vArch;
    napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH, &vArch);
    napi_set_named_property(env, res, "arch", vArch);

    napi_value vApi;
    napi_create_int32(env, 8, &vApi);
    napi_set_named_property(env, res, "nodeApiVersion", vApi);

    return res;
}

#else

static napi_value AcquireOwnership(napi_env env, napi_callback_info info) {
    napi_throw_error(env, "PLATFORM_NOT_SUPPORTED", "Native instance ownership requires Windows.");
    return NULL;
}

static napi_value IsSupported(napi_env env, napi_callback_info info) {
    napi_value res;
    napi_get_boolean(env, false, &res);
    return res;
}

static napi_value GetNativeInfo(napi_env env, napi_callback_info info) {
    napi_value res;
    napi_create_object(env, &res);
    return res;
}

#endif

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "acquireOwnership", NULL, AcquireOwnership, NULL, NULL, NULL, napi_default, NULL },
        { "isSupported", NULL, IsSupported, NULL, NULL, NULL, napi_default, NULL },
        { "getNativeInfo", NULL, GetNativeInfo, NULL, NULL, NULL, napi_default, NULL }
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
