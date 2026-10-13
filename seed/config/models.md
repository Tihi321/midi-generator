---
kind: models
shown: []
picked: []
---
# Models in the dropdown

Which models the chat's model dropdown offers: only the ticked ones. The app writes this file from Settings > Models: pick a provider, press **Detect models** to list everything it has, and tick the models you want, or add one by its id (with its price for a paid provider). You can also edit it by hand; the app picks the change up on reload.

- `shown`: `provider/model` refs ticked in the dropdown: models of `providers.md`, and models found by `discover` (OpenRouter's free models, LM Studio models that are not in `providers.md`). A model that is not here (or in `picked`) is not in the dropdown.
- `picked`: models that are in neither: ticked from a provider's list or added by id, each with its `provider`, `id`, `context` and the price the provider listed (or the one you typed; `price_in`, `price_out`, `price_cached_in`, USD per 1M tokens, display only). They are always in the dropdown.

A role list in `roles.md` can still name a model that is not ticked. An old `hidden` list is ignored.
