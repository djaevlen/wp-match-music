<?php
/**
 * Plugin Name: Match Music
 * Description: Login-protected jingle board for match days.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * Text Domain: match-music
 */

defined( 'ABSPATH' ) || exit;

define( 'MATCH_MUSIC_FILE', __FILE__ );
define( 'MATCH_MUSIC_VERSION', '0.1.0' );

require_once __DIR__ . '/includes/capabilities.php';
require_once __DIR__ . '/includes/settings.php';
require_once __DIR__ . '/includes/storage.php';
require_once __DIR__ . '/includes/tracks.php';
require_once __DIR__ . '/includes/rest.php';

add_action( 'init', 'MatchMusic\register_track_type' );
add_action( 'rest_api_init', 'MatchMusic\register_rest_routes' );
add_filter( 'rest_pre_serve_request', 'MatchMusic\rest_stream_audio', 10, 3 );
