{
  "targets": [
    {
      "target_name": "eu_native",
      "sources": [ "src/eu_native.cc" ],
      "cflags_cc": [ "-std=c++17", "-fvisibility=hidden" ],
      "conditions": [
        [ "OS=='win'", {
          "libraries": [ "-lpsapi" ]
        } ],
        [ "OS=='linux'", {
          "cflags_cc": [ "-D_GNU_SOURCE" ]
        } ]
      ]
    }
  ]
}