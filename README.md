# Bitjita GitHub Actions notifier

## Files
- bitjita-actions.js
- .github/workflows/bitjita.yml
- bitjita_storage_state.json

## GitHub setup
1. Create a GitHub repository.
2. Upload these files.
3. In repository settings, add:
   - Secret: DISCORD_WEBHOOK_URL
   - Variable: BITJITA_CLAIM_ID
4. Enable GitHub Actions.
5. Run the workflow once with workflow_dispatch.

This version posts to Discord via Webhook every 5 minutes.
