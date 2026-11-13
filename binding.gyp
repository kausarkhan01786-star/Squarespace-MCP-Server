{
  "targets": [
    {
      "target_name": "instance_ownership",
      "sources": [ "src/native/instance_ownership.c" ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        ['OS=="win"', {
          "libraries": [ "Advapi32.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0
            }
          },
          "cflags=": [],
          "ldflags=": []
        }]
      ]
    }
  ]
}
