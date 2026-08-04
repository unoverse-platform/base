/**
 * A DECLARED HOST MATCHES ANY PORT ON IT, because a port cannot be declared.
 *
 * `parsed.host` carries a non-default port; package.schema.json's allowedHosts pattern
 * forbids a colon. So comparing the two strings made every non-default port UNREACHABLE,
 * and said so in a message where the two hosts looked identical:
 *
 *   refusing a request to "127.0.0.1:4106". This package allows "127.0.0.1".
 *
 * Hidden for the whole migration because vendors are on https/443, where `host` has no port.
 * The first caller to hit it was SpatialSearch, which calls the PLATFORM on 4106 — and it
 * failed AFTER tool discovery succeeded, so an agent saw five tools and every call returned
 * `{}`. The model then answered from its own knowledge with no sign anything had failed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedHost } from "../src/manifests/runtime/http/allowedHosts.js";

test("a declared host matches the same host on a non-default port", () => {
  assert.doesNotThrow(() => assertAllowedHost("http://127.0.0.1:4106/spatial/search", ["127.0.0.1"], "T"));
  assert.doesNotThrow(() => assertAllowedHost("https://api.example.com:8443/x", ["api.example.com"], "T"));
});

test("the port does not smuggle in a DIFFERENT host", () => {
  // The rule loosens the port, never the host. This is the assertion that keeps it honest.
  // https, because plain http to a non-loopback address is refused EARLIER by the
  // non-https rule — a different protection, and asserting through it would prove nothing
  // about host matching.
  assert.throws(() => assertAllowedHost("https://127.0.0.2:4106/x", ["127.0.0.1"], "T"), /refusing a request/);
  assert.throws(() => assertAllowedHost("https://evil.example:443/x", ["api.example.com"], "T"), /refusing a request/);
});

test("a host declared WITH a port still matches, so existing fixtures keep working", () => {
  // Several guards in this suite spin an ephemeral server and declare `127.0.0.1:<port>`.
  assert.doesNotThrow(() => assertAllowedHost("http://127.0.0.1:5555/x", ["127.0.0.1:5555"], "T"));
});

test("a port does not defeat the non-https rule", () => {
  // Loopback is the documented exception; anything else on http is still refused, port or no.
  assert.throws(() => assertAllowedHost("http://api.example.com:8080/x", ["api.example.com"], "T"), /non-https/);
});
