# @pipe0/openapi-proxy

## 0.3.0

### Minor Changes

- a2729ea: The deploy API key is read from the environment variable `OPENAPI_PROXY_DEPLOY_KEY`. In 0.2.0 it was `DEPLOY_API_KEY`, a name that other tools' secrets can have too: rename the variable in your pipeline.

## 0.2.0

### Minor Changes

- 0919b23: The deploy API key is read from the environment variable `DEPLOY_API_KEY`. It was `OPENAPI_PROXY_API_KEY` before: rename the secret in your pipeline. A value in it that is not a key of openapi-proxy (they start with `oap_`) is refused before anything is sent.
