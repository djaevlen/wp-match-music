<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

const REST_NAMESPACE = 'match-music/v1';

/** HTTP status for each error code the data layer can return. */
function rest_error_statuses(): array {
	return [
		'mm_invalid_name'  => 400,
		'mm_invalid_start' => 400,
		'mm_invalid_order' => 400,
		'mm_not_found'     => 404,
		'mm_file_missing'  => 404,
		'mm_store_failed'  => 500,
	];
}

function rest_error( string $code, string $message, int $status ): \WP_Error {
	return new \WP_Error( $code, $message, [ 'status' => $status ] );
}

/** Adds an HTTP status to a data layer error that has none. */
function rest_error_from( \WP_Error $error ): \WP_Error {
	$statuses = rest_error_statuses();
	$code     = $error->get_error_code();
	return rest_error( (string) $code, $error->get_error_message(), $statuses[ $code ] ?? 500 );
}

/** @return true|\WP_Error */
function rest_permission( bool $allowed ) {
	if ( $allowed ) {
		return true;
	}
	return rest_error( 'rest_forbidden', 'Sorry, you are not allowed to do that.', rest_authorization_required_code() );
}

function rest_can_play() {
	return rest_permission( can_play() );
}

function rest_can_edit() {
	return rest_permission( can_edit() );
}

function register_rest_routes(): void {
	$id = '(?P<id>\d+)';

	register_rest_route(
		REST_NAMESPACE,
		'/tracks',
		[
			[
				'methods'             => 'GET',
				'callback'            => __NAMESPACE__ . '\rest_list_tracks',
				'permission_callback' => __NAMESPACE__ . '\rest_can_play',
			],
			[
				'methods'             => 'POST',
				'callback'            => __NAMESPACE__ . '\rest_upload_track',
				'permission_callback' => __NAMESPACE__ . '\rest_can_edit',
			],
		]
	);
	register_rest_route(
		REST_NAMESPACE,
		'/tracks/order',
		[
			'methods'             => 'PUT',
			'callback'            => __NAMESPACE__ . '\rest_order_tracks',
			'permission_callback' => __NAMESPACE__ . '\rest_can_edit',
		]
	);
	register_rest_route(
		REST_NAMESPACE,
		'/tracks/' . $id,
		[
			[
				'methods'             => 'PATCH',
				'callback'            => __NAMESPACE__ . '\rest_update_track',
				'permission_callback' => __NAMESPACE__ . '\rest_can_edit',
			],
			[
				'methods'             => 'DELETE',
				'callback'            => __NAMESPACE__ . '\rest_delete_track',
				'permission_callback' => __NAMESPACE__ . '\rest_can_edit',
			],
		]
	);
	register_rest_route(
		REST_NAMESPACE,
		'/tracks/' . $id . '/audio',
		[
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\rest_track_audio',
			'permission_callback' => __NAMESPACE__ . '\rest_can_play',
		]
	);
	register_rest_route(
		REST_NAMESPACE,
		'/settings',
		[
			[
				'methods'             => 'GET',
				'callback'            => __NAMESPACE__ . '\rest_get_settings',
				'permission_callback' => __NAMESPACE__ . '\rest_can_play',
			],
			[
				'methods'             => 'PUT',
				'callback'            => __NAMESPACE__ . '\rest_put_settings',
				'permission_callback' => __NAMESPACE__ . '\rest_can_edit',
			],
		]
	);
}

/** JSON body fields, falling back to form body fields. */
function rest_body( \WP_REST_Request $request ): array {
	$params = $request->get_json_params();
	if ( ! is_array( $params ) ) {
		$params = $request->get_body_params();
	}
	return is_array( $params ) ? $params : [];
}

function rest_list_tracks() {
	return rest_ensure_response( list_tracks() );
}

function rest_upload_limit_text(): string {
	return size_format( wp_max_upload_size() );
}

function rest_upload_track( \WP_REST_Request $request ) {
	$files = $request->get_file_params();
	$file  = isset( $files['file'] ) && is_array( $files['file'] ) ? $files['file'] : null;
	$error = $file ? (int) ( $file['error'] ?? UPLOAD_ERR_NO_FILE ) : UPLOAD_ERR_NO_FILE;

	if ( UPLOAD_ERR_NO_FILE === $error ) {
		return rest_error(
			'mm_no_file',
			sprintf( 'No file was received. The upload limit is %s.', rest_upload_limit_text() ),
			400
		);
	}

	$too_large = sprintf( 'The file is too large. The upload limit is %s.', rest_upload_limit_text() );
	if ( UPLOAD_ERR_INI_SIZE === $error || UPLOAD_ERR_FORM_SIZE === $error ) {
		return rest_error( 'mm_too_large', $too_large, 413 );
	}
	if ( UPLOAD_ERR_OK !== $error ) {
		return rest_error( 'mm_store_failed', 'The file could not be uploaded.', 500 );
	}

	$tmp_name    = (string) ( $file['tmp_name'] ?? '' );
	$client_name = (string) ( $file['name'] ?? '' );
	if ( (int) ( $file['size'] ?? 0 ) > wp_max_upload_size() ) {
		return rest_error( 'mm_too_large', $too_large, 413 );
	}
	if ( ! is_mp3( $tmp_name, $client_name ) ) {
		return rest_error( 'mm_not_mp3', 'Only mp3 files are accepted.', 415 );
	}

	$id = create_track( pathinfo( $client_name, PATHINFO_FILENAME ), $tmp_name, $client_name );
	if ( is_wp_error( $id ) ) {
		return rest_error_from( $id );
	}
	return new \WP_REST_Response( get_track( $id ), 201 );
}

function rest_update_track( \WP_REST_Request $request ) {
	$body   = rest_body( $request );
	$fields = array_intersect_key( $body, [ 'name' => true, 'start_ms' => true ] );
	$track  = update_track( (int) $request['id'], $fields );
	if ( is_wp_error( $track ) ) {
		return rest_error_from( $track );
	}
	return rest_ensure_response( $track );
}

function rest_delete_track( \WP_REST_Request $request ) {
	if ( ! delete_track( (int) $request['id'] ) ) {
		return rest_error( 'mm_not_found', 'Track not found.', 404 );
	}
	return rest_ensure_response( [ 'deleted' => true ] );
}

function rest_order_tracks( \WP_REST_Request $request ) {
	$body = rest_body( $request );
	$ids  = $body['ids'] ?? null;
	$ok   = is_array( $ids );
	if ( $ok ) {
		foreach ( $ids as $value ) {
			if ( ! is_int( $value ) && ! ( is_string( $value ) && ctype_digit( $value ) ) ) {
				$ok = false;
				break;
			}
		}
	}
	if ( ! $ok ) {
		return rest_error( 'mm_invalid_order', 'The order must list every track exactly once.', 400 );
	}

	$result = set_order( $ids );
	if ( is_wp_error( $result ) ) {
		return rest_error_from( $result );
	}
	return rest_ensure_response( list_tracks() );
}

function rest_track_audio( \WP_REST_Request $request ) {
	$id = (int) $request['id'];
	if ( null === get_track( $id ) ) {
		return rest_error( 'mm_not_found', 'Track not found.', 404 );
	}
	$path = track_file( $id );
	if ( null === $path ) {
		return rest_error( 'mm_file_missing', 'The audio file is missing.', 404 );
	}

	$response = new Audio_Response( $id );
	$response->header( 'Content-Type', 'audio/mpeg' );
	$response->header( 'Content-Length', (string) filesize( $path ) );
	$response->header( 'Cache-Control', 'private, no-store' );
	$response->header( 'X-Robots-Tag', 'noindex' );
	return $response;
}

/**
 * Marks a response that rest_track_audio() itself produced, after its permission
 * check. Envelope and OPTIONS responses are plain WP_REST_Response objects.
 */
class Audio_Response extends \WP_REST_Response {
	private $track_id;

	public function __construct( int $track_id ) {
		parent::__construct( null, 200 );
		$this->track_id = $track_id;
	}

	public function track_id(): int {
		return $this->track_id;
	}
}

/**
 * Path of the mp3 to stream, or null when this response must not be streamed.
 * Only a genuine, permitted GET/HEAD audio response qualifies; the path comes
 * only from track_file().
 */
function audio_stream_path( $result, $request ): ?string {
	if ( ! $result instanceof Audio_Response || 200 !== $result->get_status() ) {
		return null;
	}
	if ( ! $request instanceof \WP_REST_Request || ! in_array( $request->get_method(), [ 'GET', 'HEAD' ], true ) ) {
		return null;
	}
	if ( isset( $request['_envelope'] ) ) {
		return null;
	}
	if ( ! preg_match( '#^/' . preg_quote( REST_NAMESPACE, '#' ) . '/tracks/(\d+)/audio$#', $request->get_route(), $m ) ) {
		return null;
	}
	if ( (int) $m[1] !== $result->track_id() || ! can_play() ) {
		return null;
	}
	return track_file( $result->track_id() );
}

/** Streams the mp3 for a successful audio response instead of JSON-encoding it. */
function rest_stream_audio( $served, $result, $request ) {
	if ( $served ) {
		return $served;
	}
	$path = audio_stream_path( $result, $request );
	if ( null === $path ) {
		return $served;
	}

	while ( ob_get_level() > 0 ) {
		ob_end_clean();
	}
	foreach ( $result->get_headers() as $name => $value ) {
		header( $name . ': ' . $value );
	}
	readfile( $path );
	return true;
}

function rest_get_settings() {
	return rest_ensure_response( [ 'fade_ms' => get_fade_ms() ] );
}

function rest_put_settings( \WP_REST_Request $request ) {
	$body  = rest_body( $request );
	$value = $body['fade_ms'] ?? null;
	if ( is_string( $value ) && preg_match( '/^-?\d+$/', $value ) ) {
		$value = (int) $value;
	}
	if ( ! is_int( $value ) ) {
		return rest_error( 'mm_invalid_fade', 'The fade time must be a whole number of milliseconds.', 400 );
	}
	return rest_ensure_response( [ 'fade_ms' => set_fade_ms( $value ) ] );
}
