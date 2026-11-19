<?php
defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once __DIR__ . '/includes/settings.php';
require_once __DIR__ . '/includes/storage.php';
require_once __DIR__ . '/includes/tracks.php';

\MatchMusic\purge_all();
