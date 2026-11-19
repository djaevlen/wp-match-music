<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

/**
 * Absolute path of the private mp3 folder, with trailing slash.
 * Creates the folder with a deny-all .htaccess and an empty index.php.
 * The files are never served from here directly; they are only streamed by PHP
 * after a capability check, and their names are unguessable.
 */
function private_dir(): string {
	$uploads = wp_upload_dir( null, false );
	$dir     = trailingslashit( $uploads['basedir'] ) . 'match-music-private/';

	if ( ! is_dir( $dir ) ) {
		wp_mkdir_p( $dir );
	}
	if ( ! file_exists( $dir . '.htaccess' ) ) {
		$rules = "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n"
			. "<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n";
		file_put_contents( $dir . '.htaccess', $rules );
	}
	if ( ! file_exists( $dir . 'index.php' ) ) {
		file_put_contents( $dir . 'index.php', "<?php\n// Silence is golden.\n" );
	}
	return $dir;
}

/**
 * True when the client file name ends in .mp3 and the file starts with an ID3 tag
 * or an MPEG audio frame sync.
 */
function is_mp3( string $path, string $client_name ): bool {
	if ( 'mp3' !== strtolower( pathinfo( $client_name, PATHINFO_EXTENSION ) ) ) {
		return false;
	}
	if ( ! is_file( $path ) || ! is_readable( $path ) ) {
		return false;
	}
	$handle = fopen( $path, 'rb' );
	if ( false === $handle ) {
		return false;
	}
	$head = fread( $handle, 3 );
	fclose( $handle );
	if ( false === $head || strlen( $head ) < 2 ) {
		return false;
	}
	if ( 'ID3' === $head ) {
		return true;
	}
	return 0xFF === ord( $head[0] ) && 0xE0 === ( ord( $head[1] ) & 0xE0 );
}

/**
 * Moves a file into the private folder under a random name and returns that name,
 * or an empty string when it could not be stored.
 */
function store_file( string $source_path ): string {
	$filename = bin2hex( random_bytes( 16 ) ) . '.mp3';
	$target   = private_dir() . $filename;

	if ( ! @rename( $source_path, $target ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( ! copy( $source_path, $target ) ) {
			return '';
		}
		unlink( $source_path );
	}
	return $filename;
}

function file_path( string $filename ): string {
	return private_dir() . basename( $filename );
}
