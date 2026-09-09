#!/usr/bin/env osascript -l JavaScript
// ocr.js <png-path> — recognize text in an image via the Vision framework.
// Usage: osascript -l JavaScript ocr.js /path/to/img.png
function run(argv) {
  const path = argv[0];
  ObjC.import("AppKit");
  ObjC.import("Vision");
  const data = $.NSData.dataWithContentsOfFile(path);
  if (data.isNil()) return "ERROR: cannot read " + path;
  const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $.NSDictionary.dictionary);
  const req = $.VNRecognizeTextRequest.alloc.initWithCompletionHandler(function () {});
  req.recognitionLevel = 1; // fast — the accurate level fails under this JXA bridge
  req.usesLanguageCorrection = false;
  const requests = $.NSMutableArray.alloc.init;
  requests.addObject(req);
  const error = $();
  const ok = handler.performRequestsError(requests, error);
  if (ok !== true && ok?.boolValue !== true) return "ERROR: performRequests failed";
  const results = req.results;
  const lines = [];
  for (let i = 0; i < results.count; i += 1) {
    const obs = results.objectAtIndex(i);
    const cand = obs.topCandidates(1).objectAtIndex(0);
    lines.push(cand.string.js);
  }
  return lines.join("\n");
}
