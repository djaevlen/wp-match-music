<?php
use function MatchMusic\create_track;
use function MatchMusic\delete_track;
use function MatchMusic\get_track;
use function MatchMusic\list_tracks;
use function MatchMusic\private_dir;
use function MatchMusic\purge_all;
use function MatchMusic\set_order;
use function MatchMusic\track_file;
use function MatchMusic\update_track;

class TracksTest extends WP_UnitTestCase {

	private function tmp_copy() {
		$tmp = wp_tempnam( 'mm' );
		copy( dirname( __DIR__ ) . '/fixtures/short.mp3', $tmp );
		return $tmp;
	}

	public function tear_down() {
		purge_all();
		parent::tear_down();
	}

	public function test_create_and_list() {
		$id = create_track( 'Goal', $this->tmp_copy(), 'goal.mp3' );
		$t  = get_track( $id );
		$this->assertSame( 0, $t['start_ms'] );
		$this->assertSame( 'Goal', $t['name'] );
		$this->assertGreaterThan( 0, $t['size'] );
		$this->assertNotEmpty( $t['version'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.mp3$/', get_post_meta( $id, '_mm_file', true ) );
		$this->assertFileExists( track_file( $id ) );
		$this->assertEmpty( get_posts( [ 'post_type' => 'attachment', 'post_status' => 'any' ] ) );
		$this->assertArrayNotHasKey( 'file', $t );
		$this->assertStringNotContainsString( get_post_meta( $id, '_mm_file', true ), wp_json_encode( $t ) );

		$second = create_track( 'Timeout', $this->tmp_copy(), 't.mp3' );
		$this->assertSame( [ $id, $second ], wp_list_pluck( list_tracks(), 'id' ) );
	}

	public function test_update_validation() {
		$id   = create_track( 'Goal', $this->tmp_copy(), 'goal.mp3' );
		$name = 'Rock & Roll "Live" – Åge';
		$this->assertSame( $name, update_track( $id, [ 'name' => $name ] )['name'] );
		$this->assertSame( 'mm_invalid_name', update_track( $id, [ 'name' => '   ' ] )->get_error_code() );
		$this->assertSame( 'mm_invalid_name', update_track( $id, [ 'name' => str_repeat( 'a', 201 ) ] )->get_error_code() );
		$this->assertSame( 42300, update_track( $id, [ 'start_ms' => 42349 ] )['start_ms'] );
		$this->assertSame( 'mm_invalid_start', update_track( $id, [ 'start_ms' => -1 ] )->get_error_code() );
		$this->assertSame( 'mm_invalid_start', update_track( $id, [ 'start_ms' => 86400001 ] )->get_error_code() );
		$this->assertSame( 'mm_invalid_start', update_track( $id, [ 'start_ms' => 'abc' ] )->get_error_code() );
		$this->assertSame( 'mm_not_found', update_track( 999999, [ 'name' => 'x' ] )->get_error_code() );
		$this->assertSame( 42300, get_track( $id )['start_ms'] );
	}

	public function test_set_order() {
		$id     = create_track( 'A', $this->tmp_copy(), 'a.mp3' );
		$second = create_track( 'B', $this->tmp_copy(), 'b.mp3' );
		$this->assertTrue( set_order( [ $second, $id ] ) );
		$this->assertSame( [ $second, $id ], wp_list_pluck( list_tracks(), 'id' ) );
		$this->assertSame( 'mm_invalid_order', set_order( [ $id ] )->get_error_code() );
		$this->assertSame( 'mm_invalid_order', set_order( [ $id, $id ] )->get_error_code() );
	}

	public function test_files_and_delete() {
		$id     = create_track( 'A', $this->tmp_copy(), 'a.mp3' );
		$second = create_track( 'B', $this->tmp_copy(), 'b.mp3' );
		$path   = track_file( $id );
		unlink( $path );
		$this->assertNull( track_file( $id ) );
		$path2 = track_file( $second );
		$this->assertTrue( delete_track( $second ) );
		$this->assertFileDoesNotExist( $path2 );
		$this->assertNull( get_track( $second ) );
	}

	public function test_post_type_is_private() {
		$type = get_post_type_object( 'mm_track' );
		$this->assertFalse( $type->public );
		$this->assertFalse( $type->show_ui );
		$this->assertFalse( $type->show_in_rest );
		$this->assertTrue( $type->exclude_from_search );
	}

	public function test_purge_all() {
		$dir = private_dir();
		create_track( 'X', $this->tmp_copy(), 'x.mp3' );
		update_option( 'match_music_settings', [ 'fade_ms' => 1000 ] );
		purge_all();
		$this->assertSame( [], list_tracks() );
		$this->assertDirectoryDoesNotExist( $dir );
		$this->assertFalse( get_option( 'match_music_settings' ) );
	}

	public function names_provider() {
		return [
			[ 'Home <3' ],
			[ 'A <b> C' ],
			[ 'Mix %ab' ],
			[ 'Rock & Roll "Live" – Åge' ],
		];
	}

	/**
	 * @dataProvider names_provider
	 */
	public function test_names_round_trip_exactly( $name ) {
		$id = create_track( 'Start', $this->tmp_copy(), 'a.mp3' );
		foreach ( [ 'editor', 'author' ] as $role ) {
			wp_set_current_user( self::factory()->user->create( [ 'role' => $role ] ) );
			$before = has_filter( 'title_save_pre', 'wp_filter_kses' );
			$this->assertSame( $name, update_track( $id, [ 'name' => $name ] )['name'] );
			$this->assertSame( $name, get_track( $id )['name'] );
			$this->assertSame( $before, has_filter( 'title_save_pre', 'wp_filter_kses' ) );
		}
		wp_set_current_user( 0 );
		$created = get_track( create_track( $name, $this->tmp_copy(), 'b.mp3' ) );
		$this->assertSame( $name, $created['name'] );
	}

	public function test_name_whitespace_is_normalised_and_length_limited() {
		$id = create_track( 'Start', $this->tmp_copy(), 'a.mp3' );
		$this->assertSame( 'Goal Song', update_track( $id, [ 'name' => "  Goal \t\n Song  " ] )['name'] );
		$this->assertSame( 'mm_invalid_name', update_track( $id, [ 'name' => str_repeat( 'å', 201 ) ] )->get_error_code() );
		$this->assertSame( 200, mb_strlen( update_track( $id, [ 'name' => str_repeat( 'å', 200 ) ] )['name'] ) );
	}

	public function test_purge_all_works_when_post_type_is_unregistered() {
		$dir = private_dir();
		$id  = create_track( 'X', $this->tmp_copy(), 'x.mp3' );
		$path = track_file( $id );
		update_option( 'match_music_settings', [ 'fade_ms' => 1000 ] );
		unregister_post_type( 'mm_track' );
		try {
			purge_all();
		} finally {
			\MatchMusic\register_track_type();
		}
		$this->assertNull( get_post( $id ) );
		$this->assertFileDoesNotExist( $path );
		$this->assertDirectoryDoesNotExist( $dir );
		$this->assertFalse( get_option( 'match_music_settings' ) );
	}
}
