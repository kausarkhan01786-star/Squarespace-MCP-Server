{
  "targets": [
    {
      "target_name": "instance_lock",
      "sources": [ "instance_lock.c" ],
      "defines": [ "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NAPI_VERSION=8" ],
      "libraries": [ "Advapi32.lib" ]
    }
  ]
}
