<?php
/**
 * Turns a fresh WooCommerce install into a real-looking shop. Run by store-setup.sh with
 * `wp eval-file`. Idempotent: products are matched by SKU, images are imported once,
 * pages are matched by slug, and settings are simply re-applied.
 *
 *  - removes the WordPress sample post/page
 *  - creates categories and the product catalog (with photos) from catalog.json
 *  - builds a homepage with a hero banner on top of Storefront's product sections
 *  - sets up the main menu, theme colours, a store notice, footer and a photo credits page
 */
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

// `wp eval-file` may evaluate this file rather than include it, so use an explicit directory.
$dir = getenv('STORE_SCRIPTS_DIR') ?: '/scripts';
$catalog = json_decode(file_get_contents($dir . '/catalog.json'), true);

function urumi_log($msg) {
	WP_CLI::log('[storefront] ' . $msg);
}

/** Downloads an image and attaches it to $post_id. Returns the attachment id, or 0 on failure. */
function urumi_sideload($url, $name, $post_id = 0) {
	$tmp = download_url($url, 90);
	if (is_wp_error($tmp)) {
		urumi_log("could not download image for {$name}: " . $tmp->get_error_message());
		return 0;
	}
	$ext  = preg_match('/\.png$/i', $url) ? 'png' : 'jpg';
	$file = array('name' => sanitize_title($name) . '.' . $ext, 'tmp_name' => $tmp);
	$id   = media_handle_sideload($file, $post_id, $name);
	if (is_wp_error($id)) {
		@unlink($tmp);
		urumi_log("could not import image for {$name}: " . $id->get_error_message());
		return 0;
	}
	return $id;
}

// --- 1. WordPress sample content -------------------------------------------------------
foreach (array('hello-world' => 'post', 'sample-page' => 'page') as $slug => $type) {
	$sample = get_page_by_path($slug, OBJECT, $type);
	if ($sample) {
		wp_delete_post($sample->ID, true);
	}
}

// --- 2. Categories ------------------------------------------------------------------------
$category_ids = array();
foreach ($catalog['products'] as $item) {
	$name = $item['category'];
	if (isset($category_ids[$name])) {
		continue;
	}
	$term = term_exists($name, 'product_cat');
	if (!$term) {
		$term = wp_insert_term($name, 'product_cat');
	}
	$category_ids[$name] = (int) (is_array($term) ? $term['term_id'] : $term);
}

// --- 3. Products with photos -----------------------------------------------------------------
$featured = 0;
foreach ($catalog['products'] as $item) {
	$id = wc_get_product_id_by_sku($item['sku']);
	if (!$id) {
		$product = new WC_Product_Simple();
		$product->set_sku($item['sku']);
		$product->set_name($item['name']);
		$product->set_status('publish');
		$product->set_regular_price($item['price']);
		if ($item['sale_price'] !== '') {
			$product->set_sale_price($item['sale_price']);
		}
		$product->set_short_description($item['description']);
		$product->set_description($item['description']);
		$product->set_category_ids(array($category_ids[$item['category']]));
		// Sale items double as "We recommend" picks on the homepage.
		$product->set_featured($item['sale_price'] !== '');
		$id = $product->save();
		urumi_log("+ {$item['name']}");
	}
	$product = wc_get_product($id);
	if (!$product->get_image_id()) {
		$image = urumi_sideload($item['image'], $item['name'], $id);
		if ($image) {
			$product->set_image_id($image);
			$product->save();
		}
	}
	// Category tiles on the homepage use the first product photo in each category.
	$cat = $category_ids[$item['category']];
	if (!get_term_meta($cat, 'thumbnail_id', true) && $product->get_image_id()) {
		update_term_meta($cat, 'thumbnail_id', $product->get_image_id());
	}
}

// --- 4. Homepage ------------------------------------------------------------------------------------
$home = get_page_by_path('home');
if (!$home) {
	$hero = urumi_sideload($catalog['hero']['image'], 'Summer edit banner');
	$hero_url = $hero ? wp_get_attachment_url($hero) : '';
	$shop_url = get_permalink(wc_get_page_id('shop'));
	$content = '<!-- wp:cover {"url":"' . esc_url($hero_url) . '","dimRatio":50,"minHeight":440,"contentPosition":"center left","align":"full"} -->'
		. '<div class="wp-block-cover alignfull has-custom-content-position is-position-center-left urumi-hero" style="min-height:440px">'
		. '<span aria-hidden="true" class="wp-block-cover__background has-background-dim"></span>'
		. '<img class="wp-block-cover__image-background" alt="" src="' . esc_url($hero_url) . '" data-object-fit="cover"/>'
		. '<div class="wp-block-cover__inner-container">'
		. '<p class="urumi-eyebrow">New season · Free delivery across India</p>'
		. '<h2 class="urumi-hero-title">The Summer Edit</h2>'
		. '<p class="urumi-hero-text">Sunglasses, bags, watches and everyday essentials, picked for the monsoon-to-summer switch. Pay cash on delivery.</p>'
		. '<div class="wp-block-buttons"><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="' . esc_url($shop_url) . '">Shop the collection</a></div></div>'
		. '</div></div><!-- /wp:cover -->';
	$home_id = wp_insert_post(array(
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_title'   => 'Home',
		'post_name'    => 'home',
		'post_content' => $content,
	));
	update_post_meta($home_id, '_wp_page_template', 'template-homepage.php');
	$home = get_post($home_id);
	urumi_log('homepage created');
}
update_option('show_on_front', 'page');
update_option('page_on_front', $home->ID);
update_option('blogdescription', 'Everyday essentials, delivered');

// --- 5. Main menu ----------------------------------------------------------------------------------
$menu_name = 'Main menu';
$menu = wp_get_nav_menu_object($menu_name);
if (!$menu) {
	$menu_id = wp_create_nav_menu($menu_name);
	wp_update_nav_menu_item($menu_id, 0, array('menu-item-title' => 'Home', 'menu-item-url' => home_url('/'), 'menu-item-status' => 'publish', 'menu-item-type' => 'custom'));
	wp_update_nav_menu_item($menu_id, 0, array('menu-item-title' => 'Shop all', 'menu-item-object' => 'page', 'menu-item-object-id' => wc_get_page_id('shop'), 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish'));
	foreach ($category_ids as $name => $term_id) {
		wp_update_nav_menu_item($menu_id, 0, array('menu-item-title' => $name, 'menu-item-object' => 'product_cat', 'menu-item-object-id' => $term_id, 'menu-item-type' => 'taxonomy', 'menu-item-status' => 'publish'));
	}
	set_theme_mod('nav_menu_locations', array('primary' => $menu_id, 'handheld' => $menu_id));
}

// --- 6. Look and feel (Storefront theme options) ------------------------------------------------
$mods = array(
	'storefront_header_background_color'     => '#1e1b4b',
	'storefront_header_text_color'           => '#c7d2fe',
	'storefront_header_link_color'           => '#ffffff',
	'storefront_heading_color'               => '#111827',
	'storefront_text_color'                  => '#4b5563',
	'storefront_accent_color'                => '#ea580c',
	'storefront_button_background_color'     => '#4f46e5',
	'storefront_button_text_color'           => '#ffffff',
	'storefront_button_alt_background_color' => '#ea580c',
	'storefront_button_alt_text_color'       => '#ffffff',
	'storefront_footer_background_color'     => '#0f172a',
	'storefront_footer_heading_color'        => '#ffffff',
	'storefront_footer_text_color'           => '#94a3b8',
	'storefront_footer_link_color'           => '#c7d2fe',
);
foreach ($mods as $key => $value) {
	set_theme_mod($key, $value);
}
wp_update_custom_css_post(file_get_contents($dir . '/storefront.css'));

update_option('woocommerce_demo_store', 'yes');
update_option('woocommerce_demo_store_notice', 'Free delivery across India · Cash on delivery on every order · Easy 7-day returns');

// --- 7. Footer and photo credits ------------------------------------------------------------------
$credits = get_page_by_path('photo-credits');
$rows = '';
foreach (array_merge($catalog['products'], array(array('name' => 'Homepage banner', 'credit' => $catalog['hero']['credit']))) as $item) {
	$c = $item['credit'];
	$rows .= '<li><strong>' . esc_html($item['name']) . '</strong>: “' . esc_html($c['title']) . '” by ' . esc_html($c['author'])
		. ', ' . esc_html($c['license']) . ', via <a href="' . esc_url($c['source']) . '">Wikimedia Commons</a></li>';
}
$credits_content = '<p>Product photos are used under their Creative Commons licences or public-domain dedications. Product names, prices and descriptions are for demonstration only.</p><ul>' . $rows . '</ul>';
if (!$credits) {
	wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Photo credits', 'post_name' => 'photo-credits', 'post_content' => $credits_content));
} else {
	wp_update_post(array('ID' => $credits->ID, 'post_content' => $credits_content));
}

$html = get_option('widget_custom_html', array());
$html[2] = array('title' => get_option('blogname'), 'content' => '<p>Everyday essentials for work, travel and weekends. Every order ships free across India.</p>');
$html[3] = array('title' => 'Customer care', 'content' => '<p>Cash on delivery on every order<br>Delivery in 3–5 working days<br>Easy 7-day returns</p>');
$html[4] = array('title' => 'Shop', 'content' => '<p><a href="' . esc_url(get_permalink(wc_get_page_id('shop'))) . '">All products</a><br><a href="' . esc_url(get_permalink(wc_get_page_id('myaccount'))) . '">My account</a><br><a href="' . esc_url(home_url('/photo-credits/')) . '">Photo credits</a></p>');
$html['_multiwidget'] = 1;
update_option('widget_custom_html', $html);
$sidebars = get_option('sidebars_widgets', array());
$sidebars['footer-1'] = array('custom_html-2');
$sidebars['footer-2'] = array('custom_html-3');
$sidebars['footer-3'] = array('custom_html-4');
update_option('sidebars_widgets', $sidebars);

flush_rewrite_rules(false);
urumi_log('storefront ready');
