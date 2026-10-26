#!/bin/sh
# Idempotent WooCommerce store bootstrap with WP-CLI. Used for the Helm-managed main store
# (post-install/upgrade hook) and for every store created by the store provisioner.
# Safe to re-run: every step checks before it changes anything.
set -eu
cd /var/www/html
log() { echo "[store-setup] $*"; }
SCRIPTS="${STORE_SCRIPTS_DIR:-/scripts}"

log "waiting for WordPress files and the database"
i=0
until [ -f wp-config.php ] && wp db query "SELECT 1" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 120 ] && { log "gave up waiting"; exit 1; }
  sleep 5
done

if ! wp core is-installed 2>/dev/null; then
  log "installing WordPress"
  wp core install --url="$WP_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi
# Keep the admin password in sync with the Secret (supports rotation).
wp user update "$WP_ADMIN_USER" --user_pass="$WP_ADMIN_PASSWORD" --skip-email >/dev/null

wp option update timezone_string "$STORE_TIMEZONE" >/dev/null
wp option update blogname "$STORE_TITLE" >/dev/null
# The WordPress image ships the standard .htaccess rewrite rules; only the structure is set here.
wp rewrite structure '/%postname%/' >/dev/null

if ! wp plugin is-installed woocommerce; then
  log "installing WooCommerce ${WOO_VERSION:-latest}"
  if [ -n "$WOO_VERSION" ]; then wp plugin install woocommerce --version="$WOO_VERSION"; else wp plugin install woocommerce; fi
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

if [ "$INSTALL_STOREFRONT" = "true" ] && ! wp theme is-active storefront 2>/dev/null; then
  log "installing Storefront theme"
  (wp theme is-installed storefront || wp theme install storefront) && wp theme activate storefront || log "Storefront unavailable; keeping the default theme"
fi

log "configuring WooCommerce"
# New stores start in "coming soon" mode, which hides the shop from visitors.
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
wp option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
wp option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
wp option update woocommerce_calc_taxes no >/dev/null
wp option update woocommerce_enable_guest_checkout yes >/dev/null
# Demo store: no shipping step, so checkout needs only billing details.
wp option update woocommerce_ship_to_countries disabled >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
# Test-friendly payment: Cash on delivery.
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json >/dev/null

log "registering the MCP server's REST API key"
wp eval '
  global $wpdb;
  $ck = getenv("WOO_CONSUMER_KEY"); $cs = getenv("WOO_CONSUMER_SECRET");
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $hash = wc_api_hash($ck);
  $id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash));
  $user = get_user_by("login", getenv("WP_ADMIN_USER"));
  if ($id) {
    $wpdb->update($table, array("consumer_secret" => $cs, "permissions" => "read_write"), array("key_id" => $id));
    echo "REST key present\n";
  } else {
    $wpdb->insert($table, array(
      "user_id" => $user->ID, "description" => "Urumi WooCommerce MCP server", "permissions" => "read_write",
      "consumer_key" => $hash, "consumer_secret" => $cs, "truncated_key" => substr($ck, -7),
    ));
    echo "REST key created\n";
  }'

if [ "$SEED_PRODUCTS" = "true" ]; then
  log "building the storefront (catalog with photos, homepage, menu, theme)"
  wp eval-file "$SCRIPTS/storefront.php" --user="$WP_ADMIN_USER"
fi

wp cache flush >/dev/null 2>&1 || true
log "done: storefront at $WP_URL"
