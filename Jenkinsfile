pipeline {
    agent any

    environment {
        APP_DIR = "/home/ubuntu/crud-api"
        APP_NAME = "crud-api"
        HEALTH_URL = "http://127.0.0.1:4000/health"
    }

    stages {
        stage('Capture current version') {
            steps {
                script {
                    env.LAST_GOOD = sh(
                        script: "sudo -u ubuntu git -C $APP_DIR rev-parse HEAD",
                        returnStdout: true
                    ).trim()
                    echo "Last known-good commit: ${env.LAST_GOOD}"
                }
            }
        }

        stage('Build') {
            steps {
                sh 'sudo -u ubuntu git -C $APP_DIR fetch origin master'
                sh 'sudo -u ubuntu git -C $APP_DIR reset --hard origin/master'
                sh 'sudo -u ubuntu npm install --omit=dev --prefix $APP_DIR'
            }
        }

        stage('Test') {
            steps {
                sh 'sudo -u ubuntu npm test --prefix $APP_DIR'
            }
        }

        stage('Deploy') {
            steps {
                sh 'sudo -u ubuntu pm2 restart $APP_NAME --update-env'
            }
        }

        stage('Health Check') {
            steps {
                sh '''
                    for i in $(seq 1 5); do
                        code=$(curl -s -o /tmp/health.out -w "%{http_code}" --max-time 5 $HEALTH_URL || echo "000")
                        if [ "$code" = "200" ] && grep -q '"status":"healthy"' /tmp/health.out; then
                            echo "Health check passed on attempt $i"
                            exit 0
                        fi
                        echo "Attempt $i failed (code=$code), retrying in 10s..."
                        sleep 10
                    done
                    echo "Health check failed after 5 attempts"
                    exit 1
                '''
            }
        }
    }

    post {
        failure {
            echo 'Deploy failed — rolling back to last known-good commit'
            script {
                if (env.LAST_GOOD) {
                    sh "sudo -u ubuntu git -C $APP_DIR reset --hard ${env.LAST_GOOD}"
                    sh 'sudo -u ubuntu npm install --omit=dev --prefix $APP_DIR'
                    sh 'sudo -u ubuntu pm2 restart $APP_NAME --update-env'
                    echo "Rolled back to ${env.LAST_GOOD} and restarted"
                }
            }
        }
    }
}
