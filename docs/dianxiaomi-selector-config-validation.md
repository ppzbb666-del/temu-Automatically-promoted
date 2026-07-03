# Dianxiaomi Selector Config Validation

The selector config validation endpoint checks whether the current generated selector config is ready for the automation runner.

```text
GET /selector-config/validation
```

The validation reads `.runtime/dianxiaomi-selector-config.json` and compares it with the latest selector diagnosis report from `output/playwright`.

It reports:

- missing selector config file
- missing required field selectors: `title`, `description`, `price`, `stock`
- missing required button selector: `save`
- missing SKU row selector
- selectors that do not match the latest diagnosis candidate

Dashboard displays this result in the Dianxiaomi selector diagnosis panel. Regenerate the selector config after taking a fresh real Dianxiaomi snapshot if the validation shows stale selectors.
