<?php
namespace MatchMusic;

defined( 'ABSPATH' ) || exit;

function play_cap(): string {
	return (string) apply_filters( 'match_music_play_capability', 'read' );
}

function edit_cap(): string {
	return (string) apply_filters( 'match_music_edit_capability', 'edit_others_posts' );
}

function can_play(): bool {
	return current_user_can( play_cap() );
}

function can_edit(): bool {
	return current_user_can( edit_cap() );
}
