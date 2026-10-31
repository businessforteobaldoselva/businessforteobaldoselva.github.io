"use strict";
// The provider used while AI help is off or has no key: it can never be called successfully. Portable.

const { ProviderError } = require("./interface");

function createDisabledProvider() {
  return {
    id: "disabled",
    model: "none",
    async complete() { throw new ProviderError("disabled"); },
  };
}

module.exports = { createDisabledProvider };
