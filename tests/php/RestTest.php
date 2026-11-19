<?php
use function MatchMusic\create_track;
use function MatchMusic\purge_all;
use function MatchMusic\track_file;
use function MatchMusic\get_fade_ms;

class RestTest extends WP_UnitTestCase {

	private $subscriber;
	private $editor;

	public function set_up() {
		parent::set_up();
		global $wp_rest_server;
		$wp_rest_server = new WP_REST_Server();
		do_action( 'rest_api_init' );
		$this->subscriber = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		$this->editor     = self::factory()->user->create( [ 'role' => 'editor' ] );
		wp_set_current_user( $this->editor );
	}

	public function tear_down() {
		purge_all();
		global $wp_rest_server;
		$wp_rest_server = null;
		parent::tear_down();
	}

	private function tmp_copy( $fixture = 'short.mp3' ) {
		$tmp = wp_tempnam( 'mm' );
		copy( dirname( __DIR__ ) . '/fixtures/' . $fixture, $tmp );
		return $tmp;
	}

	private function dispatch( $method, $route, $body = null ) {
		$request = new WP_REST_Request( $method, '/match-music/v1' . $route );
		if ( null !== $body ) {
			$request->set_header( 'Content-Type', 'application/json' );
			$request->set_body( wp_json_encode( $body ) );
		}
		return rest_do_request( $request );
	}

	private function upload( $fixture, $client_name, $error = UPLOAD_ERR_OK ) {
		$tmp     = $this->tmp_copy( $fixture );
		$request = new WP_REST_Request( 'POST', '/match-music/v1/tracks' );
		$request->set_file_params(
			[
				'file' => [
					'name'     => $client_name,
					'type'     => 'audio/mpeg',
					'tmp_name' => $tmp,
					'error'    => $error,
					'size'     => filesize( $tmp ),
				],
			]
		);
		return rest_do_request( $request );
	}

	private function track() {
		return create_track( 'Goal', $this->tmp_copy(), 'goal.mp3' );
	}

	/** @dataProvider matrix */
	public function test_permissions( $method, $route, $anon, $subscriber, $editor ) {
		$expected = [
			0                 => $anon,
			$this->subscriber => $subscriber,
			$this->editor     => $editor,
		];
		// Subscriber and anonymous first; the editor last because it may delete the track.
		$users = [ 0, $this->subscriber, $this->editor ];
		foreach ( $users as $user ) {
			wp_set_current_user( $user );
			$id   = $this->track();
			$body = null;
			if ( 'PATCH' === $method ) {
				$body = [ 'name' => 'New' ];
			} elseif ( '/tracks/order' === $route ) {
				$body = [ 'ids' => [ $id ] ];
			} elseif ( 'PUT' === $method ) {
				$body = [ 'fade_ms' => 1000 ];
			}
			$path = str_replace( '{id}', (string) $id, $route );
			if ( 'POST' === $method ) {
				$status = $this->upload( 'short.mp3', 'Goal Song.mp3' )->get_status();
			} else {
				$status = $this->dispatch( $method, $path, $body )->get_status();
			}
			$this->assertSame( $expected[ $user ], $status, "$method $route as user $user" );
			purge_all();
		}
	}

	public function matrix() {
		return [
			[ 'GET', '/tracks', 401, 200, 200 ],
			[ 'POST', '/tracks', 401, 403, 201 ],
			[ 'PATCH', '/tracks/{id}', 401, 403, 200 ],
			[ 'DELETE', '/tracks/{id}', 401, 403, 200 ],
			[ 'PUT', '/tracks/order', 401, 403, 200 ],
			[ 'GET', '/tracks/{id}/audio', 401, 200, 200 ],
			[ 'GET', '/settings', 401, 200, 200 ],
			[ 'PUT', '/settings', 401, 403, 200 ],
		];
	}

	public function test_denied_requests_change_nothing() {
		$id = $this->track();
		wp_set_current_user( $this->subscriber );
		$this->dispatch( 'PATCH', "/tracks/$id", [ 'name' => 'Hacked' ] );
		$this->dispatch( 'DELETE', "/tracks/$id" );
		$this->dispatch( 'PUT', '/settings', [ 'fade_ms' => 5000 ] );
		$this->upload( 'short.mp3', 'x.mp3' );
		$this->assertSame( 'Goal', MatchMusic\get_track( $id )['name'] );
		$this->assertCount( 1, MatchMusic\list_tracks() );
		$this->assertSame( 2000, get_fade_ms() );
	}

	public function test_upload() {
		$r = $this->upload( 'short.mp3', 'Goal Song.mp3' );
		$this->assertSame( 201, $r->get_status() );
		$this->assertSame( 'Goal Song', $r->get_data()['name'] );
		$this->assertSame( [ 'id', 'name', 'start_ms', 'order', 'size', 'version' ], array_keys( $r->get_data() ) );

		$this->assertSame( 201, $this->upload( 'short-noid3.mp3', 'raw.mp3' )->get_status() );
		$this->assertSame( 415, $this->upload( 'fake.mp3', 'fake.mp3' )->get_status() );
		$this->assertSame( 415, $this->upload( 'short.mp3', 'short.wav' )->get_status() );
		$this->assertSame( 'mm_not_mp3', $this->upload( 'fake.mp3', 'fake.mp3' )->get_data()['code'] );
		$this->assertCount( 2, MatchMusic\list_tracks() );

		$none = $this->dispatch( 'POST', '/tracks' );
		$this->assertSame( 400, $none->get_status() );
		$this->assertSame( 'mm_no_file', $none->get_data()['code'] );
		$this->assertStringContainsString( size_format( wp_max_upload_size() ), $none->get_data()['message'] );

		$big = $this->upload( 'short.mp3', 'a.mp3', UPLOAD_ERR_INI_SIZE );
		$this->assertSame( 413, $big->get_status() );
		$this->assertSame( 'mm_too_large', $big->get_data()['code'] );
		$this->assertStringContainsString( size_format( wp_max_upload_size() ), $big->get_data()['message'] );
		$this->assertSame( 413, $this->upload( 'short.mp3', 'a.mp3', UPLOAD_ERR_FORM_SIZE )->get_status() );
		$this->assertSame( 400, $this->upload( 'short.mp3', '.mp3' )->get_status() );
	}

	public function test_upload_ignores_path_in_body() {
		$request = new WP_REST_Request( 'POST', '/match-music/v1/tracks' );
		$request->set_body_params( [ 'file' => $this->tmp_copy(), 'tmp_name' => $this->tmp_copy() ] );
		$request->set_query_params( [ 'file' => $this->tmp_copy() ] );
		$this->assertSame( 'mm_no_file', rest_do_request( $request )->get_data()['code'] );
	}

	public function test_update_list_delete() {
		$id   = $this->track();
		$name = 'Rock & Roll "Live" – Åge';
		$this->assertSame( $name, $this->dispatch( 'PATCH', "/tracks/$id", [ 'name' => $name ] )->get_data()['name'] );
		$this->assertSame( $name, $this->dispatch( 'GET', '/tracks' )->get_data()[0]['name'] );
		$this->assertSame( 42300, $this->dispatch( 'PATCH', "/tracks/$id", [ 'start_ms' => 42349 ] )->get_data()['start_ms'] );
		$this->assertSame( $name, $this->dispatch( 'GET', '/tracks' )->get_data()[0]['name'] );
		$this->assertSame( 404, $this->dispatch( 'PATCH', '/tracks/999999', [ 'name' => 'x' ] )->get_status() );
		$this->assertSame( 400, $this->dispatch( 'PATCH', "/tracks/$id", [ 'name' => '  ' ] )->get_status() );
		$this->assertSame( 'mm_invalid_name', $this->dispatch( 'PATCH', "/tracks/$id", [ 'name' => '  ' ] )->get_data()['code'] );
		$bad = $this->dispatch( 'PATCH', "/tracks/$id", [ 'start_ms' => -5 ] );
		$this->assertSame( 400, $bad->get_status() );
		$this->assertSame( 'mm_invalid_start', $bad->get_data()['code'] );

		$file = track_file( $id );
		$del  = $this->dispatch( 'DELETE', "/tracks/$id" );
		$this->assertSame( 200, $del->get_status() );
		$this->assertSame( [ 'deleted' => true ], $del->get_data() );
		$this->assertFileDoesNotExist( $file );
		$this->assertSame( 404, $this->dispatch( 'DELETE', "/tracks/$id" )->get_status() );
		$this->assertSame( 'mm_not_found', $this->dispatch( 'DELETE', "/tracks/$id" )->get_data()['code'] );
	}

	public function test_order() {
		$a = $this->track();
		$b = $this->track();
		$r = $this->dispatch( 'PUT', '/tracks/order', [ 'ids' => [ $b, $a ] ] );
		$this->assertSame( [ $b, $a ], wp_list_pluck( $r->get_data(), 'id' ) );
		foreach ( [ [ $a ], [ $a, $a ], [ $a, $b, 99999 ], 'nope', [ 'x', 'y' ] ] as $ids ) {
			$bad = $this->dispatch( 'PUT', '/tracks/order', [ 'ids' => $ids ] );
			$this->assertSame( 400, $bad->get_status() );
			$this->assertSame( 'mm_invalid_order', $bad->get_data()['code'] );
		}
		$this->assertSame( 'mm_invalid_order', $this->dispatch( 'PUT', '/tracks/order', [] )->get_data()['code'] );
	}

	public function test_audio() {
		$id = $this->track();
		$a  = $this->dispatch( 'GET', "/tracks/$id/audio" );
		$h  = $a->get_headers();
		$this->assertSame( 200, $a->get_status() );
		$this->assertSame( 'audio/mpeg', $h['Content-Type'] );
		$this->assertSame( 'private, no-store', $h['Cache-Control'] );
		$this->assertSame( 'noindex', $h['X-Robots-Tag'] );
		$this->assertSame( (string) filesize( track_file( $id ) ), (string) $h['Content-Length'] );
		$this->assertStringNotContainsString( basename( track_file( $id ) ), wp_json_encode( $h ) );

		$this->assertSame( 'mm_not_found', $this->dispatch( 'GET', '/tracks/999999/audio' )->get_data()['code'] );
		$this->assertSame( 404, $this->dispatch( 'GET', '/tracks/999999/audio' )->get_status() );

		unlink( track_file( $id ) );
		$gone = $this->dispatch( 'GET', "/tracks/$id/audio" );
		$this->assertSame( 404, $gone->get_status() );
		$this->assertSame( 'mm_file_missing', $gone->get_data()['code'] );
	}

	public function test_audio_stream_path_only_for_genuine_permitted_get() {
		$id  = $this->track();
		$get = new WP_REST_Request( 'GET', "/match-music/v1/tracks/$id/audio" );

		wp_set_current_user( $this->subscriber );
		$genuine = rest_do_request( $get );
		$this->assertInstanceOf( MatchMusic\Audio_Response::class, $genuine );
		$this->assertSame( track_file( $id ), MatchMusic\audio_stream_path( $genuine, $get ) );

		$head = new WP_REST_Request( 'HEAD', "/match-music/v1/tracks/$id/audio" );
		$this->assertSame( track_file( $id ), MatchMusic\audio_stream_path( $genuine, $head ) );

		$options = new WP_REST_Request( 'OPTIONS', "/match-music/v1/tracks/$id/audio" );
		$this->assertNull( MatchMusic\audio_stream_path( $genuine, $options ) );
		$this->assertNull( MatchMusic\audio_stream_path( new WP_REST_Response( [], 200 ), $get ) );
		$this->assertNull( MatchMusic\audio_stream_path( new WP_REST_Response( null, 200 ), $options ) );

		$enveloped = new WP_REST_Request( 'GET', "/match-music/v1/tracks/$id/audio" );
		$enveloped->set_param( '_envelope', '1' );
		$this->assertNull( MatchMusic\audio_stream_path( $genuine, $enveloped ) );
		$this->assertNull( MatchMusic\audio_stream_path( new WP_REST_Response( [ 'body' => [] ], 200 ), $enveloped ) );

		$other = new WP_REST_Request( 'GET', '/match-music/v1/tracks/' . ( $id + 1 ) . '/audio' );
		$this->assertNull( MatchMusic\audio_stream_path( $genuine, $other ) );

		wp_set_current_user( 0 );
		$this->assertNull( MatchMusic\audio_stream_path( $genuine, $get ) );

		wp_set_current_user( $this->subscriber );
		add_filter( 'match_music_play_capability', function () { return 'manage_network'; } );
		$this->assertNull( MatchMusic\audio_stream_path( $genuine, $get ) );
	}

	public function test_anonymous_envelope_and_options_yield_no_audio() {
		$id = $this->track();
		wp_set_current_user( 0 );
		$server = rest_get_server();

		$request = new WP_REST_Request( 'GET', "/match-music/v1/tracks/$id/audio" );
		$request->set_param( '_envelope', '1' );
		$result = rest_do_request( $request );
		$this->assertNotInstanceOf( MatchMusic\Audio_Response::class, $result );
		$enveloped = $server->envelope_response( $result, false );
		$this->assertNull( MatchMusic\audio_stream_path( $enveloped, $request ) );
		$this->assertSame( 401, $enveloped->get_data()['status'] );

		$options = new WP_REST_Request( 'OPTIONS', "/match-music/v1/tracks/$id/audio" );
		$result  = rest_do_request( $options );
		$this->assertNotInstanceOf( MatchMusic\Audio_Response::class, $result );
		$this->assertNull( MatchMusic\audio_stream_path( $result, $options ) );

		$this->assertFalse( apply_filters( 'rest_pre_serve_request', false, $enveloped, $request, $server ) );
		$this->assertFalse( apply_filters( 'rest_pre_serve_request', false, $result, $options, $server ) );
	}

	public function test_plugin_routes_switch_off_page_caching() {
		wp_set_current_user( $this->subscriber );
		$this->dispatch( 'GET', '/settings' );
		$this->assertTrue( defined( 'DONOTCACHEPAGE' ) && DONOTCACHEPAGE );
	}

	public function test_clear_output_buffers_removes_buffers_above_the_floor() {
		$floor = ob_get_level();
		ob_start();
		echo 'notice from another plugin';
		ob_start();
		echo 'more';
		MatchMusic\clear_output_buffers( $floor );
		$this->assertSame( $floor, ob_get_level() );
	}

	public function test_clear_output_buffers_stops_at_a_buffer_it_cannot_remove() {
		// In a separate PHP process: PHPUnit itself cannot cope with a buffer that cannot be removed.
		$script = wp_tempnam( 'mm-ob' );
		file_put_contents(
			$script,
			'<?php
			namespace {
				define( "ABSPATH", __DIR__ );
				class WP_REST_Response {}
				require $argv[1];
				ob_start( null, 0, PHP_OUTPUT_HANDLER_STDFLAGS & ~PHP_OUTPUT_HANDLER_REMOVABLE );
				ob_start();
				echo "junk";
				\MatchMusic\clear_output_buffers();
				fwrite( STDERR, "level=" . ob_get_level() );
			}'
		);
		$rest = dirname( __DIR__, 2 ) . '/match-music/includes/rest.php';
		$cmd  = escapeshellarg( PHP_BINARY ) . ' -d max_execution_time=5 -d display_errors=stderr '
			. escapeshellarg( $script ) . ' ' . escapeshellarg( $rest ) . ' 2>&1';
		exec( $cmd, $out, $code );
		unlink( $script );
		$this->assertSame( 0, $code, implode( "\n", $out ) );
		$this->assertSame( [ 'level=1' ], $out ); // the top buffer went; the stuck one stayed; no spin, no notice
	}

	public function test_settings() {
		$this->assertSame( [ 'fade_ms' => 2000 ], $this->dispatch( 'GET', '/settings' )->get_data() );
		$this->assertSame( 2500, $this->dispatch( 'PUT', '/settings', [ 'fade_ms' => 2300 ] )->get_data()['fade_ms'] );
		$this->assertSame( 2500, $this->dispatch( 'GET', '/settings' )->get_data()['fade_ms'] );
		foreach ( [ 'abc', 1.5, null, [ 1 ] ] as $bad ) {
			$r = $this->dispatch( 'PUT', '/settings', [ 'fade_ms' => $bad ] );
			$this->assertSame( 400, $r->get_status() );
			$this->assertSame( 'mm_invalid_fade', $r->get_data()['code'] );
		}
		$this->assertSame( 'mm_invalid_fade', $this->dispatch( 'PUT', '/settings', [] )->get_data()['code'] );
		$this->assertSame( 2500, get_fade_ms() );
	}
}
