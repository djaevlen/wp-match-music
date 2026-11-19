<?php
use function MatchMusic\board_slug;
use function MatchMusic\board_url;
use function MatchMusic\boot_data;

class BoardPageTest extends WP_UnitTestCase {

	public function tear_down() {
		remove_all_filters( 'match_music_board_slug' );
		$this->set_permalink_structure( '' );
		parent::tear_down();
	}

	public function test_boot_data_shape_and_values() {
		$subscriber = self::factory()->user->create( [ 'role' => 'subscriber' ] );
		$editor     = self::factory()->user->create( [ 'role' => 'editor' ] );

		wp_set_current_user( $subscriber );
		$b = boot_data();
		$this->assertSame( [ 'restUrl', 'nonce', 'nonceUrl', 'canEdit', 'maxUploadBytes', 'loginUrl', 'fadeMs' ], array_keys( $b ) );
		$this->assertFalse( $b['canEdit'] );
		$this->assertSame( 2000, $b['fadeMs'] );
		$this->assertStringEndsWith( '/match-music/v1/', $b['restUrl'] );

		wp_set_current_user( $editor );
		$this->assertTrue( boot_data()['canEdit'] );
	}

	public function test_board_url_and_slug_filter() {
		$this->set_permalink_structure( '/%postname%/' );
		$this->assertSame( 'match-music', board_slug() );
		$this->assertStringEndsWith( '/match-music/', board_url() );

		$this->set_permalink_structure( '' );
		$this->assertStringContainsString( 'mm_board=1', board_url() );

		add_filter(
			'match_music_board_slug',
			function () {
				return 'kampmusik';
			}
		);
		$this->set_permalink_structure( '/%postname%/' );
		$this->assertStringEndsWith( '/kampmusik/', board_url() );
	}

	public function test_query_var_and_rewrite_rule_registered() {
		$this->set_permalink_structure( '/%postname%/' );
		$this->assertContains( 'mm_board', apply_filters( 'query_vars', [] ) );
		$rules = get_option( 'rewrite_rules' );
		$this->assertSame( 'index.php?mm_board=1', $rules['^match-music/?$'] );
	}
}
