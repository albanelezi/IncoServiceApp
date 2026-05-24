// Stubs firebase-functions imports so v2 code can be loaded standalone in Node.
module.exports.https = {
  onCall: (opts, fn) => fn,
  HttpsError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } },
};
