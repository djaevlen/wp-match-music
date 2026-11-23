<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

const TRACK_POST_TYPE = 'mm_track';
const MAX_NAME_LENGTH = 200;
const MAX_START_MS    = 86400000;
const START_STEP_MS   = 100;

function register_track_type(): void {
	register_post_type(
		TRACK_POST_TYPE,
		[
			'public'              => false,
			'show_ui'             => false,
			'show_in_rest'        => false,
			'exclude_from_search' => true,
			'supports'            => [ 'title' ],
			'rewrite'             => false,
			'query_var'           => false,
		]
	);
}

/**
 * Track names are plain text: stored exactly (no HTML encoding, no tag stripping) and
 * escaped by whoever outputs them. Only invalid UTF-8, control characters and
 * whitespace runs are cleaned.
 *
 * @return string|\WP_Error
 */
function validate_name( $name ) {
	$name = is_string( $name ) ? wp_check_invalid_utf8( $name ) : '';
	$name = preg_replace( '/\p{Cc}+/u', ' ', $name );
	$name = trim( preg_replace( '/\s+/u', ' ', (string) $name ) );
	$len  = function_exists( 'mb_strlen' ) ? mb_strlen( $name ) : strlen( $name );
	if ( '' === $name || $len > MAX_NAME_LENGTH ) {
		return new \WP_Error( 'mm_invalid_name', 'The track name must be 1 to 200 characters.' );
	}
	return $name;
}

/** @return int|\WP_Error */
function validate_start_ms( $value ) {
	if ( ! is_numeric( $value ) || (float) $value !== floor( (float) $value ) || $value < 0 || $value > MAX_START_MS ) {
		return new \WP_Error( 'mm_invalid_start', 'The start point must be a whole number of milliseconds from 0 to 86400000.' );
	}
	return (int) ( round( $value / START_STEP_MS ) * START_STEP_MS );
}

/**
 * Whether Space may pick the track at random. Only a real boolean is accepted, so a form
 * value such as "false" can never switch a track on by accident.
 *
 * @return bool|\WP_Error
 */
function validate_quick_play( $value ) {
	if ( ! is_bool( $value ) ) {
		return new \WP_Error( 'mm_invalid_quick_play', 'Quick play must be true or false.' );
	}
	return $value;
}

/**
 * Runs a post write without the kses title filter, so a name such as "Home <3" is saved
 * exactly as given. The filter is restored even when a save hook throws.
 */
function write_raw( callable $write ) {
	$had_filter = false !== has_filter( 'title_save_pre', 'wp_filter_kses' );
	if ( $had_filter ) {
		remove_filter( 'title_save_pre', 'wp_filter_kses' );
	}
	try {
		return $write();
	} finally {
		if ( $had_filter ) {
			add_filter( 'title_save_pre', 'wp_filter_kses' );
		}
	}
}

function next_order(): int {
	$last = get_posts(
		[
			'post_type'      => TRACK_POST_TYPE,
			'post_status'    => 'any',
			'posts_per_page' => 1,
			'orderby'        => 'menu_order',
			'order'          => 'DESC',
			'fields'         => 'ids',
		]
	);
	return $last ? (int) get_post_field( 'menu_order', $last[0] ) + 1 : 0;
}

/** @return int|\WP_Error */
function create_track( string $name, string $source_path, string $original_name ) {
	$name = validate_name( $name );
	if ( is_wp_error( $name ) ) {
		return $name;
	}

	$filename = store_file( $source_path );
	if ( '' === $filename ) {
		return new \WP_Error( 'mm_store_failed', 'The file could not be stored.' );
	}

	$id = write_raw(
		function () use ( $name ) {
			return wp_insert_post(
				wp_slash(
					[
						'post_type'   => TRACK_POST_TYPE,
						'post_status' => 'publish',
						'post_title'  => $name,
						'menu_order'  => next_order(),
					]
				),
				true
			);
		}
	);
	if ( is_wp_error( $id ) ) {
		unlink( file_path( $filename ) );
		return $id;
	}

	update_post_meta( $id, '_mm_file', $filename );
	update_post_meta( $id, '_mm_start_ms', 0 );
	update_post_meta( $id, '_mm_size', (int) filesize( file_path( $filename ) ) );
	update_post_meta( $id, '_mm_original_name', sanitize_text_field( $original_name ) );
	update_post_meta( $id, '_mm_version', bin2hex( random_bytes( 8 ) ) );
	return (int) $id;
}

function get_track( int $id ): ?array {
	$post = get_post( $id );
	if ( ! $post || TRACK_POST_TYPE !== $post->post_type ) {
		return null;
	}
	return [
		'id'         => (int) $post->ID,
		'name'       => $post->post_title,
		'start_ms'   => (int) get_post_meta( $post->ID, '_mm_start_ms', true ),
		// On unless switched off: a track saved before the setting existed has no value.
		'quick_play' => '0' !== get_post_meta( $post->ID, '_mm_quick_play', true ),
		'order'      => (int) $post->menu_order,
		'size'       => (int) get_post_meta( $post->ID, '_mm_size', true ),
		'version'    => (string) get_post_meta( $post->ID, '_mm_version', true ),
	];
}

function list_tracks(): array {
	$ids = get_posts(
		[
			'post_type'      => TRACK_POST_TYPE,
			'post_status'    => 'any',
			'posts_per_page' => -1,
			'orderby'        => [
				'menu_order' => 'ASC',
				'ID'         => 'ASC',
			],
			'fields'         => 'ids',
		]
	);
	return array_map( __NAMESPACE__ . '\get_track', $ids );
}

/** @return array|\WP_Error */
function update_track( int $id, array $fields ) {
	if ( null === get_track( $id ) ) {
		return new \WP_Error( 'mm_not_found', 'Track not found.' );
	}

	$name  = null;
	$start = null;
	$quick = null;
	if ( array_key_exists( 'name', $fields ) ) {
		$name = validate_name( $fields['name'] );
		if ( is_wp_error( $name ) ) {
			return $name;
		}
	}
	if ( array_key_exists( 'start_ms', $fields ) ) {
		$start = validate_start_ms( $fields['start_ms'] );
		if ( is_wp_error( $start ) ) {
			return $start;
		}
	}

	if ( array_key_exists( 'quick_play', $fields ) ) {
		$quick = validate_quick_play( $fields['quick_play'] );
		if ( is_wp_error( $quick ) ) {
			return $quick;
		}
	}

	if ( null !== $name ) {
		write_raw(
			function () use ( $id, $name ) {
				return wp_update_post( wp_slash( [ 'ID' => $id, 'post_title' => $name ] ) );
			}
		);
	}
	if ( null !== $start ) {
		update_post_meta( $id, '_mm_start_ms', $start );
	}
	if ( null !== $quick ) {
		update_post_meta( $id, '_mm_quick_play', $quick ? '1' : '0' );
	}
	return get_track( $id );
}

function delete_track( int $id ): bool {
	if ( null === get_track( $id ) ) {
		return false;
	}
	$path = track_file( $id );
	if ( $path ) {
		unlink( $path );
	}
	return (bool) wp_delete_post( $id, true );
}

/** @return true|\WP_Error */
function set_order( array $ids ) {
	$ids      = array_map( 'intval', $ids );
	$existing = wp_list_pluck( list_tracks(), 'id' );
	$sorted   = $ids;
	sort( $sorted );
	sort( $existing );
	if ( $sorted !== $existing ) {
		return new \WP_Error( 'mm_invalid_order', 'The order must list every track exactly once.' );
	}

	global $wpdb;
	foreach ( array_values( $ids ) as $position => $id ) {
		$wpdb->update( $wpdb->posts, [ 'menu_order' => $position ], [ 'ID' => $id ] );
		clean_post_cache( $id );
	}
	return true;
}

function track_file( int $id ): ?string {
	$filename = get_post_meta( $id, '_mm_file', true );
	if ( ! is_string( $filename ) || '' === $filename ) {
		return null;
	}
	$path = file_path( $filename );
	return is_file( $path ) ? $path : null;
}

/** Removes every track, the private folder and the settings option. */
function purge_all(): void {
	foreach ( list_tracks() as $track ) {
		wp_delete_post( $track['id'], true );
	}

	$uploads = wp_upload_dir( null, false );
	$dir     = trailingslashit( $uploads['basedir'] ) . 'match-music-private/';
	if ( is_dir( $dir ) ) {
		foreach ( (array) scandir( $dir ) as $entry ) {
			if ( '.' !== $entry && '..' !== $entry && is_file( $dir . $entry ) ) {
				unlink( $dir . $entry );
			}
		}
		rmdir( $dir );
	}

	delete_option( OPTION_NAME );
}
