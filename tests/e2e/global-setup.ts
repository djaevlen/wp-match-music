import { test as setup } from '@playwright/test';
import { resetBoard, users, wp, wpPhp } from './helpers';

// Runs once before the e2e projects (a setup project, so the gate suite never touches WordPress).
setup('prepare the local WordPress', () => {
  setup.setTimeout(120_000);

  wp('rewrite', 'structure', '/%postname%/');
  wp('rewrite', 'flush');

  // Create or reset each test account: known password, exactly the expected role (or none).
  wpPhp(
    `
    foreach ( $in as $u ) {
      $user = get_user_by( 'login', $u['login'] );
      $id   = $user ? $user->ID : wp_insert_user( [
        'user_login' => $u['login'],
        'user_pass'  => $u['password'],
        'user_email' => $u['login'] . '@example.test',
        'role'       => $u['role'],
      ] );
      if ( is_wp_error( $id ) ) { WP_CLI::error( $id->get_error_message() ); }
      wp_set_password( $u['password'], $id );
      $user = new WP_User( $id );
      $user->set_role( $u['role'] );
      if ( '' === $u['role'] && $user->has_cap( 'read' ) ) { WP_CLI::error( $u['login'] . ' still has read' ); }
    }
  `,
    Object.values(users),
  );

  resetBoard();
});
