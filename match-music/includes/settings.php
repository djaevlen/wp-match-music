<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

const OPTION_NAME     = 'match_music_settings';
const DEFAULT_FADE_MS = 2000;
const MAX_FADE_MS     = 10000;
const FADE_STEP_MS    = 500;

function get_fade_ms(): int {
	$settings = get_option( OPTION_NAME, [] );
	if ( is_array( $settings ) && isset( $settings['fade_ms'] ) && is_numeric( $settings['fade_ms'] ) ) {
		return normalize_fade_ms( (int) $settings['fade_ms'] );
	}
	return DEFAULT_FADE_MS;
}

function set_fade_ms( int $ms ): int {
	$ms       = normalize_fade_ms( $ms );
	$settings = get_option( OPTION_NAME, [] );
	if ( ! is_array( $settings ) ) {
		$settings = [];
	}
	$settings['fade_ms'] = $ms;
	update_option( OPTION_NAME, $settings );
	return $ms;
}

function normalize_fade_ms( int $ms ): int {
	$ms = (int) ( round( $ms / FADE_STEP_MS ) * FADE_STEP_MS );
	return max( 0, min( MAX_FADE_MS, $ms ) );
}
