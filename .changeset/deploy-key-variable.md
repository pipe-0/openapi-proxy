---
"@pipe0/openapi-proxy": minor
---

The deploy API key is read from the environment variable `OPENAPI_PROXY_DEPLOY_KEY`. In 0.2.0 it was `DEPLOY_API_KEY`, a name that other tools' secrets can have too: rename the variable in your pipeline.
