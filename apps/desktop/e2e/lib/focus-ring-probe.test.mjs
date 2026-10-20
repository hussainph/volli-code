import assert from "node:assert/strict";
import test from "node:test";

import { focusRingIsReady } from "./focus-ring-probe.mjs";

const ready = () => ({
  focusVisible: true,
  opacity: "1",
  css: {
    offsetWidth: "2px",
    ringShadow: "0 0 0 calc(2px + 2px) #9c441e",
    boxShadow: "rgba(253, 222, 210, 1) 0px 0px 0px 2px, rgba(156, 68, 30, 1) 0px 0px 0px 4px",
  },
});

test("accepts the settled two-pixel focus ring and resolved declaration", () => {
  assert.equal(focusRingIsReady(ready()), true);
  const focus = ready();
  focus.css.ringShadow = "rgb(156, 68, 30) 0px 0px 0px 4px";
  assert.equal(focusRingIsReady(focus), true);
});

test("REGRESSION: the measured 1.99963px / 3.99926px interpolation is ready", () => {
  const focus = ready();
  focus.css.boxShadow =
    "rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, " +
    "rgba(253, 222, 210, 1) 0px 0px 0px 1.99963px, rgba(156, 68, 30, 1) 0px 0px 0px 3.99926px, " +
    "rgba(72, 42, 30, 0) 0px 0.00018415px 0.000368301px 0px, " +
    "rgba(72, 42, 30, 0) 0px 0.000368301px 0.00128905px -0.00018415px";
  assert.equal(focusRingIsReady(focus), true);
});

test("requires focus-visible and fully opaque control", () => {
  assert.equal(focusRingIsReady({ ...ready(), focusVisible: false }), false);
  assert.equal(focusRingIsReady({ ...ready(), opacity: "0.999" }), false);
});

test("missing, still-interpolating, thinner or thicker rings are not ready", () => {
  for (const spread of [0, 2, 3, 3.99, 5]) {
    const focus = ready();
    focus.css.boxShadow = `rgb(253, 222, 210) 0px 0px 0px 2px, rgb(156, 68, 30) 0px 0px 0px ${spread}px`;
    assert.equal(focusRingIsReady(focus), false, `ring spread=${spread}`);
  }
  const focus = ready();
  focus.css.boxShadow = "none";
  assert.equal(focusRingIsReady(focus), false);
});

test("a blur, inset shadow or displaced shadow containing 2px is not an offset", () => {
  for (const shadow of ["0px 0px 2px 0px", "inset 0px 0px 0px 2px", "2px 0px 0px 2px"]) {
    const focus = ready();
    focus.css.boxShadow = `${shadow} #fff, 0px 0px 0px 4px #9c441e`;
    assert.equal(focusRingIsReady(focus), false, shadow);
  }
});

test("requires both the declared ring and the actual two-pixel offset", () => {
  const focus = ready();
  focus.css.ringShadow = "0 0 #0000";
  assert.equal(focusRingIsReady(focus), false);
  focus.css.ringShadow = ready().css.ringShadow;
  focus.css.offsetWidth = "1px";
  assert.equal(focusRingIsReady(focus), false);
  focus.css.offsetWidth = "2px";
  focus.css.boxShadow = "rgb(156, 68, 30) 0px 0px 0px 4px";
  assert.equal(focusRingIsReady(focus), false);
});
