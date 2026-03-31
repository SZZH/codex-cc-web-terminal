# Security Policy

## Reporting a Vulnerability

If you find a security issue, do not open a public issue first.

Please report details to the maintainers privately with:

- impact summary
- reproduction steps
- affected files/endpoints
- suggested mitigation (if available)

We will acknowledge receipt and provide a remediation timeline.

## Deployment Notes

- Always set a strong `ACCESS_TOKEN`.
- For private deployments, prefer `TAILSCALE_ONLY=true` or strict `TRUSTED_CIDRS`.
- Do not expose this service publicly without additional authentication and network controls.

