{
  "targets": [
    {
      "target_name": "termbridge",
      "sources": [ "src/addon.cc" ],
      "include_dirs": [ "<!(node -p \"require('node-addon-api').include_dir\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        [ "OS==\"mac\"", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CFLAGS": [ "-O3" ]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/IOSurface.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreFoundation.framework"
            ]
          }
        } ]
      ]
    }
  ]
}
