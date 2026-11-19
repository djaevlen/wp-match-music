<?php
use function MatchMusic\can_edit;
use function MatchMusic\can_play;

class CapabilitiesTest extends WP_UnitTestCase {

	public function test_roles() {
		$this->assertFalse( can_play() );
		$this->assertFalse( can_edit() );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'subscriber' ] ) );
		$this->assertTrue( can_play() );
		$this->assertFalse( can_edit() );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'author' ] ) );
		$this->assertFalse( can_edit() );

		wp_set_current_user( self::factory()->user->create( [ 'role' => 'editor' ] ) );
		$this->assertTrue( can_play() );
		$this->assertTrue( can_edit() );
	}

	public function test_caps_are_filterable() {
		add_filter(
			'match_music_edit_capability',
			function () {
				return 'read';
			}
		);
		wp_set_current_user( self::factory()->user->create( [ 'role' => 'subscriber' ] ) );
		$this->assertTrue( can_edit() );
	}
}
