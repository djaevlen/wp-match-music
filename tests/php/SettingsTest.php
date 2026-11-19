<?php
use function MatchMusic\get_fade_ms;
use function MatchMusic\set_fade_ms;

class SettingsTest extends WP_UnitTestCase {

	public function test_fade_default_and_rounding() {
		$this->assertSame( 2000, get_fade_ms() );
		$this->assertSame( 2500, set_fade_ms( 2300 ) );
		$this->assertSame( 2500, get_fade_ms() );
	}

	public function test_fade_is_clamped() {
		$this->assertSame( 0, set_fade_ms( -5 ) );
		$this->assertSame( 0, get_fade_ms() );
		$this->assertSame( 10000, set_fade_ms( 99999 ) );
	}
}
