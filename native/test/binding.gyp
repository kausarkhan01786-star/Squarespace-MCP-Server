{
  "targets": [
    {
      "target_name": "instance_lock_test",
      "sources": [ "../instance_lock.c" ],
      "defines": [ "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NAPI_VERSION=8", "INSTANCE_LOCK_TEST_ADDON=1" ],
      "libraries": [ "Advapi32.lib" ]
    }
  ]
}
