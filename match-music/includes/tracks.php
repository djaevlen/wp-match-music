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

/** @return string|\WP_Error */
function validate_name( $name ) {
	$name = is_string( $name ) ? sanitize_text_field( $name ) : '';
	if ( '' === $name || mb_strlen( $name ) > MAX_NAME_LENGTH ) {
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
 * Runs a post write without the kses title filters, so the title stays exactly as saved
 * (the name is sanitized by sanitize_text_field and escaped on output).
 */
function write_raw( callable $write ) {
	$had_filters = false !== has_filter( 'title_save_pre', 'wp_filter_kses' );
	if ( $had_filters ) {
		kses_remove_filters();
	}
	$result = $write();
	if ( $had_filters ) {
		kses_init_filters();
	}
	return $result;
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
		'id'       => (int) $post->ID,
		'name'     => $post->post_title,
		'start_ms' => (int) get_post_meta( $post->ID, '_mm_start_ms', true ),
		'order'    => (int) $post->menu_order,
		'size'     => (int) get_post_meta( $post->ID, '_mm_size', true ),
		'version'  => (string) get_post_meta( $post->ID, '_mm_version', true ),
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
