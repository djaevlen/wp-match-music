<?php
$match_music_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $match_music_tests_dir ) {
	$match_music_tests_dir = rtrim( sys_get_temp_dir(), '/\\' ) . '/wordpress-tests-lib';
}

require_once dirname( __DIR__, 2 ) . '/vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php';
require_once $match_music_tests_dir . '/includes/functions.php';

tests_add_filter(
	'muplugins_loaded',
	function () {
		require dirname( __DIR__, 2 ) . '/match-music/match-music.php';
	}
);

require $match_music_tests_dir . '/includes/bootstrap.php';
