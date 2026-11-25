# Windows: "Get verification code" button stays disabled

**Affected:** SoduWork desktop client v1.13.19, Windows 11 x64, default Hub `https://service.soduwork.ai`

## Symptom

On the sign-up page, after entering an email address, the "Get verification code" button stays greyed out and cannot be clicked. Retrying or restarting the client does not help.

## Root cause

The client requests the Hub's `client-auth/policy` endpoint on startup. In some networks the response body is very large (~85 KB, contains embedded HTML) and takes longer than the client's ~8s timeout, so the request fails. The client does not retry and does not surface the failure, leaving the button disabled.

## Workaround

Run a small caching forward proxy locally and point the client at it, e.g.:

```
127.0.0.1:8899 -> https://service.soduwork.ai  (cache the policy response)
```

With the proxy the endpoint responds in milliseconds and the verification flow works normally.

## Suggested fix

- Server: return a compact JSON response (compress / split the payload).
- Client: add timeout feedback and automatic retry; show a visible error state instead of leaving the button permanently disabled.
