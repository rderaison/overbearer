pipeline {
    agent any

    parameters {
        string(name: 'OVERBEARER_REGISTRY', defaultValue: 'ghcr.io/rderaison/overbearer', description: 'Container image registry')
        string(name: 'OVERBEARER_REGISTRY_CREDS', defaultValue: 'GHCR_IO_LOGIN', description: 'Jenkins credentials ID for docker login')
    }

    environment {
        REGISTRY           = "${params.OVERBEARER_REGISTRY}"
        REGISTRY_CREDS_ID  = "${params.OVERBEARER_REGISTRY_CREDS}"
        IMAGE_TAG          = "${(env.BRANCH_NAME ?: 'main') == 'main' ? 'latest' : env.BRANCH_NAME + '-' + env.BUILD_NUMBER}"
        DOCKER_API_VERSION = '1.43'
    }

    stages {
        stage('Build Images') {
            parallel {
                stage('Proxy Image') {
                    steps {
                        sh "docker build -f Dockerfile.proxy -t ${REGISTRY}/proxy:${IMAGE_TAG} ."
                    }
                }
                stage('Management Image') {
                    steps {
                        sh "docker build -f Dockerfile.api -t ${REGISTRY}/management:${IMAGE_TAG} ."
                    }
                }
            }
        }

        stage('Push Images') {
            steps {
                script {
                    def registryHost = REGISTRY.split('/')[0]
                    if (REGISTRY_CREDS_ID == 'DOCKER_SECLIO_REGISTRY') {
                        // File-based docker config (same as Jenkinsfile.e2e)
                        withCredentials([file(credentialsId: REGISTRY_CREDS_ID, variable: 'DOCKER_CONFIG_FILE')]) {
                            sh "mkdir -p \$HOME/.docker && cp \$DOCKER_CONFIG_FILE \$HOME/.docker/config.json"
                        }
                    } else {
                        // Username/password credentials (e.g. GHCR)
                        withCredentials([usernamePassword(credentialsId: REGISTRY_CREDS_ID, usernameVariable: 'USER', passwordVariable: 'TOKEN')]) {
                            sh "echo \$TOKEN | docker login ${registryHost} -u \$USER --password-stdin"
                        }
                    }
                }
                sh "docker push ${REGISTRY}/proxy:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/management:${IMAGE_TAG}"
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f --filter="label=overbearer" || true'
        }
        failure {
            echo 'Build failed!'
        }
        success {
            echo "Images: ${REGISTRY}/proxy:${IMAGE_TAG}, ${REGISTRY}/management:${IMAGE_TAG}"
        }
    }
}
