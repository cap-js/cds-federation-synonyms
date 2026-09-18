# HTTP

To run the queries in _syn-config.http_, or to run the test in _syn-config.test.js_:
create a file _.env_ with this content
```sh
domain=
tenant_id=
tenant_host=
mtx_host=
cookie=
```
and add the necessary information.


## Auth

* `cf login` (using `--sso` or user/pw)
* bash get-tokens.sh
  - writes `token` and `mtx_token` to _.env_

