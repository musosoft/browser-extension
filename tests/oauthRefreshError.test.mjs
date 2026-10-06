import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshTokenFailureMessage } from '../entrypoints/utils/oauthRefreshError.ts'

test('refresh diagnostics expose only HTTP status and a short safe OAuth error code', () => {
    for (const code of ['invalid_grant', 'invalid_client', 'Error.code-1', 'a'.repeat(64)]) {
        const body = JSON.stringify({
            error: code,
            error_description: 'sensitive server description',
            access_token: 'secret-access-token',
            refresh_token: 'secret-refresh-token',
            url: 'https://private.example/oauth/token?secret=hidden',
        })
        assert.equal(
            refreshTokenFailureMessage(400, body),
            `Failed to refresh token (HTTP 400; OAuth error: ${code})`,
        )
    }
})

test('refresh diagnostics replace unsafe or non-string OAuth errors with a generic code', () => {
    for (const error of [
        '', 'a'.repeat(65), 'invalid grant', 'invalid_grant\n', 'invalid_grant\r',
        'invalid_grant\t', 'invalid_grant\u0000', 'https://private.example/token',
        'invalid_grant?token=secret', '<script>secret</script>', 'é',
        null, 123, true, ['invalid_grant'], { token: 'secret' },
    ]) {
        assert.equal(
            refreshTokenFailureMessage(401, JSON.stringify({ error })),
            'Failed to refresh token (HTTP 401; OAuth error: server_rejected)',
        )
    }
})

test('refresh diagnostics safely handle empty, malformed, and unexpected response bodies', () => {
    for (const body of ['', 'secret raw body', '<html>secret</html>', '{', 'null', '123',
        '"invalid_grant"', '[]', '[{"error":"invalid_grant"}]', '{}',
        '{"error_description":"secret"}',
    ]) {
        assert.equal(
            refreshTokenFailureMessage(503, body),
            'Failed to refresh token (HTTP 503; OAuth error: server_rejected)',
        )
    }
})
