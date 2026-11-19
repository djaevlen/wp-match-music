<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

const BOARD_QUERY_VAR = 'mm_board';
const BOARD_ENTRY     = 'src/main.tsx';

function board_slug(): string {
	return (string) apply_filters( 'match_music_board_slug', 'match-music' );
}

function board_url(): string {
	if ( get_option( 'permalink_structure' ) ) {
		return home_url( '/' . board_slug() . '/' );
	}
	return home_url( '/?' . BOARD_QUERY_VAR . '=1' );
}

function register_board_rewrite(): void {
	add_rewrite_rule( '^' . board_slug() . '/?$', 'index.php?' . BOARD_QUERY_VAR . '=1', 'top' );
}

function register_board_query_var( array $vars ): array {
	$vars[] = BOARD_QUERY_VAR;
	return $vars;
}

function activate(): void {
	register_board_rewrite();
	flush_rewrite_rules();
}

function deactivate(): void {
	flush_rewrite_rules();
}

function add_plugin_action_link( array $links ): array {
	array_unshift( $links, '<a href="' . esc_url( board_url() ) . '">' . esc_html__( 'Open board', 'match-music' ) . '</a>' );
	return $links;
}

function boot_data(): array {
	return [
		'restUrl'        => rest_url( REST_NAMESPACE . '/' ),
		'nonce'          => wp_create_nonce( 'wp_rest' ),
		'nonceUrl'       => admin_url( 'admin-ajax.php?action=rest-nonce' ),
		'canEdit'        => can_edit(),
		'maxUploadBytes' => wp_max_upload_size(),
		'loginUrl'       => wp_login_url( board_url() ),
		'fadeMs'         => get_fade_ms(),
	];
}

/** Built asset URLs for the front-end entry, read from the Vite manifest. */
function board_assets(): array {
	$dir      = plugin_dir_path( MATCH_MUSIC_FILE ) . 'build/';
	$manifest = is_readable( $dir . '.vite/manifest.json' ) ? json_decode( (string) file_get_contents( $dir . '.vite/manifest.json' ), true ) : null;
	$entry    = is_array( $manifest ) && isset( $manifest[ BOARD_ENTRY ] ) ? $manifest[ BOARD_ENTRY ] : null;
	if ( ! $entry ) {
		return [
			'js'  => '',
			'css' => [],
		];
	}
	$base = plugins_url( 'build/', MATCH_MUSIC_FILE );
	$css  = [];
	foreach ( isset( $entry['css'] ) ? $entry['css'] : [] as $file ) {
		$css[] = $base . $file;
	}
	return [
		'js'  => $base . $entry['file'],
		'css' => $css,
	];
}

function render_board(): void {
	if ( ! get_query_var( BOARD_QUERY_VAR ) ) {
		return;
	}
	if ( ! is_user_logged_in() ) {
		auth_redirect();
	}
	if ( ! can_play() ) {
		wp_die( esc_html__( 'Sorry, you are not allowed to open the board.', 'match-music' ), '', [ 'response' => 403 ] );
	}

	disable_page_cache();
	nocache_headers();
	header( 'X-Robots-Tag: noindex, nofollow' );
	header( 'Content-Type: text/html; charset=' . get_option( 'blog_charset' ) );

	$assets = board_assets();
	?>
<!doctype html>
<html lang="<?php echo esc_attr( get_bloginfo( 'language' ) ); ?>">
<head>
<meta charset="<?php echo esc_attr( get_option( 'blog_charset' ) ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Match music</title>
	<?php foreach ( $assets['css'] as $href ) : ?>
<link rel="stylesheet" href="<?php echo esc_url( $href ); ?>">
<?php endforeach; ?>
</head>
<body>
<div id="root"></div>
<script>window.MatchMusicBoot = <?php echo wp_json_encode( boot_data() ); ?>;</script>
	<?php if ( $assets['js'] ) : ?>
<script type="module" src="<?php echo esc_url( $assets['js'] ); ?>"></script>
<?php endif; ?>
</body>
</html>
	<?php
	exit;
}
