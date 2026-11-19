<?php
use function MatchMusic\file_path;
use function MatchMusic\is_mp3;
use function MatchMusic\private_dir;
use function MatchMusic\store_file;

class StorageTest extends WP_UnitTestCase {

	private $fx;

	public function set_up() {
		parent::set_up();
		$this->fx = dirname( __DIR__ ) . '/fixtures/';
	}

	public function test_private_dir_is_protected() {
		$dir = private_dir();
		$this->assertStringEndsWith( '/', $dir );
		$this->assertStringContainsString( 'match-music-private', $dir );
		$this->assertFileExists( $dir . '.htaccess' );
		$this->assertFileExists( $dir . 'index.php' );
		$htaccess = file_get_contents( $dir . '.htaccess' );
		$this->assertStringContainsString( 'Require all denied', $htaccess );
		$this->assertStringContainsString( 'Deny from all', $htaccess );
	}

	public function test_is_mp3_checks_extension_and_signature() {
		$this->assertTrue( is_mp3( $this->fx . 'short.mp3', 'short.mp3' ) );
		$this->assertTrue( is_mp3( $this->fx . 'short-noid3.mp3', 'SHORT.MP3' ) );
		$this->assertFalse( is_mp3( $this->fx . 'fake.mp3', 'fake.mp3' ) );
		$this->assertFalse( is_mp3( $this->fx . 'short.mp3', 'short.wav' ) );
		$this->assertFalse( is_mp3( $this->fx . 'missing.mp3', 'missing.mp3' ) );
	}

	public function test_store_file_moves_source_to_random_name() {
		$tmp = wp_tempnam( 'mm' );
		copy( $this->fx . 'short.mp3', $tmp );
		$name = store_file( $tmp );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.mp3$/', $name );
		$this->assertFileExists( file_path( $name ) );
		$this->assertFileDoesNotExist( $tmp );
		$this->assertSame( private_dir() . $name, file_path( '../../' . $name ) );
		unlink( file_path( $name ) );
	}
}
